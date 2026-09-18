import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, lower, applyLens, layout, layoutLayered } from '../src/index.js';

const DIR = process.env.EXAMPLES ?? new URL('../../../spec/examples/', import.meta.url).pathname;
const examples = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith('.arch')).sort() : [];

const inside = (p: { x: number; y: number }, n: { x: number; y: number; w: number; h: number }, eps = 3) =>
  p.x >= n.x - eps && p.x <= n.x + n.w + eps && p.y >= n.y - eps && p.y <= n.y + n.h + eps;

test('the two-phase layout keeps every reference architecture near the screen aspect, with every edge attached', { skip: !examples.length }, async () => {
  for (const f of examples) {
    const g = applyLens(lower(parse(readFileSync(join(DIR, f), 'utf8')).doc), { lens: 'logical' });
    const l = await layout(g);
    const byId = new Map(l.nodes.map(n => [n.id, n]));
    assert.ok(l.nodes.every(n => [n.x, n.y, n.w, n.h].every(Number.isFinite)), `${f}: finite positions`);
    const w = Math.max(...l.nodes.map(n => n.x + n.w)) - Math.min(...l.nodes.map(n => n.x));
    const h = Math.max(...l.nodes.map(n => n.y + n.h)) - Math.min(...l.nodes.map(n => n.y));
    assert.ok(w / h > 1.0 && w / h < 3.0, `${f}: aspect ${(w / h).toFixed(2)} should sit between 1 and 3`);
    assert.equal(l.edges.length, g.edges.length, `${f}: every edge routed`);
    for (const e of l.edges) {
      const a = byId.get(e.from)!, b = byId.get(e.to)!;
      assert.ok(inside(e.points[0]!, a) && inside(e.points[e.points.length - 1]!, b), `${f}: ${e.from}→${e.to} attached at both ends`);
    }
    // members never leave their frame
    for (const n of l.nodes) for (const f2 of l.nodes)
      if (f2.isBoundary && n.id !== f2.id && (n.id.startsWith(f2.id + '.') || n.id.startsWith(f2.id + '/')))
        assert.ok(inside({ x: n.x, y: n.y }, f2) && inside({ x: n.x + n.w, y: n.y + n.h }, f2), `${f}: ${n.id} inside ${f2.id}`);
  }
});

test('the single-pass layout is still there behind `strategy: layered`', async () => {
  const g = applyLens(lower(parse('actor u\nservice a\nu calls a\n').doc), { lens: 'logical' });
  const a = await layout(g, { strategy: 'layered' }), b = await layoutLayered(g);
  assert.deepEqual(a.nodes.map(n => [n.id, n.x, n.y]), b.nodes.map(n => [n.id, n.x, n.y]));
});
