/**
 * Orthogonal connectors with a memory — the geometry behind "drag a card and
 * the arrow stretches instead of being redrawn" (draw.io's behaviour).
 *
 * A route is a polyline from a point on the source's border to a point on the
 * target's border, every segment horizontal or vertical. Three operations:
 *
 *   sidePoint / autoSides   where an arrow leaves and enters a box;
 *   orthoThrough            a route through the waypoints a person set;
 *   repairRoute             the old route with only its end segments moved,
 *                           after one or both boxes moved.
 *
 * Nothing here avoids obstacles: that is the A* router's job when there is no
 * route yet. Once a route exists, a person owns its shape.
 */
import type { Pt, Rect, Side } from './route.js';

export type { Pt, Rect, Side };

/** Where an arrow attaches: a side of the box and a position along it (0…1, default the middle). */
export interface Anchor { side?: Side; t?: number }

const EPS = 0.01;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

/** The point on `side` of `r`, `t` of the way along it (left→right, top→bottom). */
export function sidePoint(r: Rect, side: Side, t = 0.5): Pt {
  const k = Math.max(0.02, Math.min(0.98, t));
  switch (side) {
    case 'top': return { x: r.x + r.w * k, y: r.y };
    case 'bottom': return { x: r.x + r.w * k, y: r.y + r.h };
    case 'left': return { x: r.x, y: r.y + r.h * k };
    case 'right': return { x: r.x + r.w, y: r.y + r.h * k };
  }
}

/** Which side of `r` a border point sits on (the nearest edge), and how far along it. */
export function anchorOf(p: Pt, r: Rect): Required<Anchor> {
  const d = { left: Math.abs(p.x - r.x), right: Math.abs(p.x - (r.x + r.w)), top: Math.abs(p.y - r.y), bottom: Math.abs(p.y - (r.y + r.h)) };
  const side = (Object.keys(d) as Side[]).reduce((a, b) => (d[b] < d[a] ? b : a));
  const t = side === 'left' || side === 'right' ? (p.y - r.y) / (r.h || 1) : (p.x - r.x) / (r.w || 1);
  return { side, t: Math.max(0, Math.min(1, t)) };
}

/** Sides for an arrow from `a` to `b` by where they sit: leave towards the target, enter from the source. */
export function autoSides(a: Rect, b: Rect): [Side, Side] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  // overlap in one axis means the boxes are stacked in the other
  const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  if (gapY >= 0 && (gapY >= gapX || gapX < 0)) return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
}

const outward = (side: Side): Pt => side === 'left' ? { x: -1, y: 0 } : side === 'right' ? { x: 1, y: 0 } : side === 'top' ? { x: 0, y: -1 } : { x: 0, y: 1 };
const horizontal = (side: Side) => side === 'left' || side === 'right';

/**
 * Repeated points go, and so does a point that merely sits on a straight run.
 * A point where the run turns back on itself stays: it is a waypoint someone
 * put there, and a spike is at least honest about it.
 */
export function tidy(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || !same(q.x, p.x) || !same(q.y, p.y)) out.push({ x: p.x, y: p.y });
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    const colH = same(a.y, b.y) && same(b.y, c.y) && (b.x - a.x) * (c.x - b.x) >= 0;
    const colV = same(a.x, b.x) && same(b.x, c.x) && (b.y - a.y) * (c.y - b.y) >= 0;
    if (colH || colV) out.splice(i, 1);
  }
  return out;
}

/**
 * A route from `a` to `b` through `hints`, in order. Consecutive points that
 * do not share an axis get a corner; the corner continues the direction the
 * route was already travelling, so a person's waypoints read as "go here,
 * then here" rather than as a puzzle. With no hints the result is the
 * straight line, the L or the Z the two sides call for.
 */
export function orthoThrough(a: Rect, b: Rect, hints: Pt[] = [], from: Anchor = {}, to: Anchor = {}, stub = 16): Pt[] {
  const [autoA, autoB] = autoSides(a, b);
  const sa = from.side ?? autoA, sb = to.side ?? autoB;
  const P = sidePoint(a, sa, from.t), E = sidePoint(b, sb, to.t);
  const oa = outward(sa), ob = outward(sb);
  const S = { x: P.x + oa.x * stub, y: P.y + oa.y * stub };
  const T = { x: E.x + ob.x * stub, y: E.y + ob.y * stub };

  // the stubs keep the first and last legs perpendicular to their sides; a
  // waypoint already sitting on that line, further out, makes the stub redundant
  const onStubLine = (h: Pt, from: Pt, o: Pt) => (o.x ? same(h.y, from.y) && (h.x - from.x) * o.x >= 0 : same(h.x, from.x) && (h.y - from.y) * o.y >= 0);
  const first = hints[0], last = hints[hints.length - 1];
  const pts: Pt[] = first && onStubLine(first, P, oa) ? [P] : [P, S];
  let horiz = horizontal(sa);              // the direction the route is travelling
  const walk = (n: Pt, preferHoriz: boolean | null = null) => {
    const c = pts[pts.length - 1]!;
    if (same(c.x, n.x) || same(c.y, n.y)) { pts.push(n); horiz = same(c.y, n.y) ? !same(c.x, n.x) : false; return; }
    const goH = preferHoriz ?? horiz;
    pts.push(goH ? { x: n.x, y: c.y } : { x: c.x, y: n.y });
    pts.push(n);
    horiz = !goH;
  };
  for (const h of hints) walk(h);
  if (!hints.length) {
    // no waypoints: an L when the sides face each other on the diagonal, a Z otherwise
    const hA = horizontal(sa), hB = horizontal(sb);
    if (hA === hB) {
      // the Z between the stubs — unless a stub points away from the other box,
      // in which case the route goes around the outside (leaving by the top to
      // reach something below means: up, across, down past it, in from below)
      const facing = hA ? (T.x - S.x) * oa.x >= 0 && (S.x - T.x) * ob.x >= 0 : (T.y - S.y) * oa.y >= 0 && (S.y - T.y) * ob.y >= 0;
      if (facing) {
        const mid = hA ? { x: (S.x + T.x) / 2, y: 0 } : { x: 0, y: (S.y + T.y) / 2 };
        if (hA) { pts.push({ x: mid.x, y: S.y }); pts.push({ x: mid.x, y: T.y }); }
        else { pts.push({ x: S.x, y: mid.y }); pts.push({ x: T.x, y: mid.y }); }
      } else if (hA) {
        const lo = Math.min(a.y, b.y) - 24, hi = Math.max(a.y + a.h, b.y + b.h) + 24;
        const y = Math.abs((S.y + T.y) / 2 - lo) < Math.abs((S.y + T.y) / 2 - hi) ? lo : hi;
        pts.push({ x: S.x, y }); pts.push({ x: T.x, y });
      } else {
        const lo = Math.min(a.x, b.x) - 24, hi = Math.max(a.x + a.w, b.x + b.w) + 24;
        const x = Math.abs((S.x + T.x) / 2 - lo) < Math.abs((S.x + T.x) / 2 - hi) ? lo : hi;
        pts.push({ x, y: S.y }); pts.push({ x, y: T.y });
      }
      pts.push(T); pts.push(E);
      return tidy(pts);
    }
    pts.push(hA ? { x: T.x, y: S.y } : { x: S.x, y: T.y });
    pts.push(T); pts.push(E);
    return tidy(pts);
  }
  // the last leg arrives at T along the axis the side needs, then steps onto the border
  if (last && onStubLine(last, E, ob)) { pts.push(E); return tidy(pts); }
  walk(T, !horizontal(sb));
  pts.push(E);
  return tidy(pts);
}

/**
 * Move only what must move. `points` is the previous route (border to border),
 * `a` and `b` are the boxes where they are now, `prevA`/`prevB` where they were
 * (so the arrow keeps leaving from the same spot on the same side). Interior
 * bends stay; the first and last bends slide along their own axis so the end
 * segments still meet the borders squarely — and stay at least a stub's length
 * outside the box. When the old shape cannot hold, the route is rebuilt from
 * the same two sides.
 */
export function repairRoute(points: Pt[], a: Rect, b: Rect, prevA?: Rect, prevB?: Rect, stub = 16): Pt[] {
  const old = tidy(points);
  if (old.length < 2) return orthoThrough(a, b);
  const fa = anchorOf(old[0]!, prevA ?? a), fb = anchorOf(old[old.length - 1]!, prevB ?? b);
  const P = sidePoint(a, fa.side, fa.t), E = sidePoint(b, fb.side, fb.t);
  const inner = old.slice(1, -1).map(p => ({ x: p.x, y: p.y }));
  // when the old shape cannot hold, the boxes have moved enough that the sides are re-chosen too
  const fallback = () => orthoThrough(a, b, [], {}, {}, stub);
  if (!inner.length) return same(P.x, E.x) || same(P.y, E.y) ? [P, E] : fallback();

  const n = inner.length;
  const hA = horizontal(fa.side), hB = horizontal(fb.side);
  if (n === 1 && hA === hB) return fallback();            // one bend cannot serve two parallel sides
  // was each interior segment horizontal? (old[i] → old[i+1], i = 1 … n-1)
  const segH = inner.map((_, i) => i < n - 1 && same(old[i + 1]!.y, old[i + 2]!.y));

  // the source end: the first bend sits on the axis leaving P, at least a stub away
  const oa = outward(fa.side);
  if (hA) { inner[0]!.y = P.y; inner[0]!.x = oa.x > 0 ? Math.max(inner[0]!.x, P.x + stub) : Math.min(inner[0]!.x, P.x - stub); }
  else { inner[0]!.x = P.x; inner[0]!.y = oa.y > 0 ? Math.max(inner[0]!.y, P.y + stub) : Math.min(inner[0]!.y, P.y - stub); }
  for (let i = 0; i < n - 1; i++) { if (segH[i]) inner[i + 1]!.y = inner[i]!.y; else inner[i + 1]!.x = inner[i]!.x; }

  // the target end, the same way, walking back
  const ob = outward(fb.side), L = inner[n - 1]!;
  if (hB) { L.y = E.y; L.x = ob.x > 0 ? Math.max(L.x, E.x + stub) : Math.min(L.x, E.x - stub); }
  else { L.x = E.x; L.y = ob.y > 0 ? Math.max(L.y, E.y + stub) : Math.min(L.y, E.y - stub); }
  for (let i = n - 1; i > 0; i--) { if (segH[i - 1]) inner[i - 1]!.y = inner[i]!.y; else inner[i - 1]!.x = inner[i]!.x; }

  // did walking back disturb the source end, or pull the first bend back into the box?
  const first = inner[0]!;
  if (hA ? !same(first.y, P.y) : !same(first.x, P.x)) return fallback();
  const away = hA ? (first.x - P.x) * oa.x : (first.y - P.y) * oa.y;
  if (away < stub - 1) return fallback();
  const out = tidy([P, ...inner, E]);
  return isOrthogonal(out) ? out : fallback();
}

/** True when every segment is horizontal or vertical. */
export const isOrthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || same(p.x, pts[i - 1]!.x) || same(p.y, pts[i - 1]!.y));
