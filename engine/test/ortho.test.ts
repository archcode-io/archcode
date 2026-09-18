import test from 'node:test';
import assert from 'node:assert/strict';
import { sidePoint, anchorOf, autoSides, orthoThrough, repairRoute, isOrthogonal, tidy } from '../src/layout/ortho.js';

const A = { x: 0, y: 0, w: 100, h: 60 }, B = { x: 300, y: 200, w: 100, h: 60 };
const onBorder = (p: { x: number; y: number }, r: typeof A) =>
  (Math.abs(p.x - r.x) < 0.01 || Math.abs(p.x - r.x - r.w) < 0.01) && p.y >= r.y - 0.01 && p.y <= r.y + r.h + 0.01
  || (Math.abs(p.y - r.y) < 0.01 || Math.abs(p.y - r.y - r.h) < 0.01) && p.x >= r.x - 0.01 && p.x <= r.x + r.w + 0.01;

test('sidePoint and anchorOf are inverses', () => {
  for (const side of ['top', 'right', 'bottom', 'left'] as const) for (const t of [0.1, 0.5, 0.9]) {
    const a = anchorOf(sidePoint(B, side, t), B);
    assert.equal(a.side, side); assert.ok(Math.abs(a.t - t) < 0.01);
  }
});

test('autoSides: beside → right/left, stacked → bottom/top', () => {
  assert.deepEqual(autoSides(A, { x: 300, y: 10, w: 100, h: 60 }), ['right', 'left']);
  assert.deepEqual(autoSides({ x: 300, y: 10, w: 100, h: 60 }, A), ['left', 'right']);
  assert.deepEqual(autoSides(A, { x: 10, y: 200, w: 100, h: 60 }), ['bottom', 'top']);
  assert.deepEqual(autoSides({ x: 10, y: 200, w: 100, h: 60 }, A), ['top', 'bottom']);
});

test('orthoThrough without hints: L or Z, ends on the borders, orthogonal', () => {
  for (const [from, to] of [[{}, {}], [{ side: 'right' }, { side: 'left' }], [{ side: 'bottom' }, { side: 'left' }], [{ side: 'right' }, { side: 'top' }], [{ side: 'top' }, { side: 'bottom' }]] as const) {
    const r = orthoThrough(A, B, [], from, to);
    assert.ok(isOrthogonal(r), JSON.stringify(r));
    assert.ok(onBorder(r[0]!, A) && onBorder(r[r.length - 1]!, B));
    assert.ok(r.length >= 2 && r.length <= 6);   // up to the six points of a route around the outside
  }
});

test('orthoThrough passes through its hints, in order', () => {
  const hints = [{ x: 200, y: 30 }, { x: 200, y: 150 }, { x: 260, y: 150 }];
  const r = orthoThrough(A, B, hints, { side: 'right' }, { side: 'top' });
  assert.ok(isOrthogonal(r));
  // every hint lies on the polyline (a hint on a straight run leaves no bend of its own)
  const onSeg = (h: { x: number; y: number }) => r.some((p, i) => i > 0 && (
    (Math.abs(p.x - r[i - 1]!.x) < 0.01 && Math.abs(h.x - p.x) < 0.01 && h.y >= Math.min(p.y, r[i - 1]!.y) - 0.01 && h.y <= Math.max(p.y, r[i - 1]!.y) + 0.01) ||
    (Math.abs(p.y - r[i - 1]!.y) < 0.01 && Math.abs(h.y - p.y) < 0.01 && h.x >= Math.min(p.x, r[i - 1]!.x) - 0.01 && h.x <= Math.max(p.x, r[i - 1]!.x) + 0.01)));
  for (const h of hints) assert.ok(onSeg(h), JSON.stringify([h, r]));
  assert.deepEqual(r[r.length - 1], sidePoint(B, 'top'));
});

test('repairRoute keeps the interior when the far end did not move', () => {
  const r0 = orthoThrough(A, B, [{ x: 200, y: 30 }, { x: 200, y: 230 }], { side: 'right' }, { side: 'left' });
  const A2 = { ...A, y: 40 };                                  // the source slid down
  const r1 = repairRoute(r0, A2, B, A, B);
  assert.ok(isOrthogonal(r1), JSON.stringify(r1));
  assert.deepEqual(r1[0], sidePoint(A2, 'right'));             // same side, same spot
  assert.deepEqual(r1[r1.length - 1], r0[r0.length - 1]);      // the target end is untouched
  // the vertical middle segment still stands at x = 200
  assert.ok(r1.some((p, i) => i > 0 && Math.abs(p.x - 200) < 0.01 && Math.abs(r1[i - 1]!.x - 200) < 0.01), JSON.stringify(r1));
});

test('repairRoute: moving the target moves only the last segment', () => {
  const r0 = orthoThrough(A, B, [{ x: 200, y: 30 }, { x: 200, y: 230 }], { side: 'right' }, { side: 'left' });
  const B2 = { ...B, y: 260, x: 340 };
  const r1 = repairRoute(r0, A, B2, A, B);
  assert.ok(isOrthogonal(r1));
  assert.deepEqual(r1[0], r0[0]);
  assert.deepEqual(r1[r1.length - 1], sidePoint(B2, 'left'));
  assert.equal(r1.length, r0.length);
});

test('repairRoute rebuilds when the shape cannot hold', () => {
  const straight = [{ x: 100, y: 30 }, { x: 300, y: 30 }];      // right → left, aligned
  const r = repairRoute(straight, A, { ...B, y: 100, x: 300 }, A, { x: 300, y: 0, w: 100, h: 60 });
  assert.ok(isOrthogonal(r) && r.length >= 3, JSON.stringify(r));
  assert.deepEqual(r[0], sidePoint(A, 'right'));
});

test('repairRoute never folds back through the source box', () => {
  const r0 = orthoThrough(A, B, [{ x: 200, y: 30 }, { x: 200, y: 230 }], { side: 'right' }, { side: 'left' });
  const A2 = { ...A, x: 250 };                                 // the source jumped past the bend
  const r1 = repairRoute(r0, A2, B, A, B);
  assert.ok(isOrthogonal(r1));
  // rebuilt from fresh sides: it leaves the source and never runs back through it
  const inside = (p: { x: number; y: number }) => p.x > A2.x + 0.5 && p.x < A2.x + A2.w - 0.5 && p.y > A2.y + 0.5 && p.y < A2.y + A2.h - 0.5;
  assert.ok(!r1.slice(1).some(inside), JSON.stringify(r1));
});

test('tidy drops collinear and repeated points', () => {
  assert.deepEqual(tidy([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }]), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }]);
});
