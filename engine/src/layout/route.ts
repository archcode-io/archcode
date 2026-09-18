/**
 * Obstacle-aware orthogonal router: a Hanan grid drawn at every obstacle
 * border (± clearance, two lanes) plus the endpoints, searched with A* and a
 * bend penalty. Deterministic — ties break by insertion order. A shared
 * `used` map makes later edges prefer lanes nobody has taken yet.
 */

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type Side = 'top' | 'bottom' | 'left' | 'right';

export const M = 16, LANE = 14, BEND = 70, REUSE = 40;

const insideRect = (p: Pt, r: Rect, eps = 0.5) =>
  p.x > r.x + eps && p.x < r.x + r.w - eps && p.y > r.y + eps && p.y < r.y + r.h - eps;

export interface Grid { X: number[]; Y: number[]; obstacles: Rect[] }

export function makeGrid(obstacles: Rect[], extra: Pt[] = []): Grid {
  const xs = new Set<number>(), ys = new Set<number>();
  for (const r of obstacles) {
    for (const d of [M, M + LANE]) { xs.add(r.x - d); xs.add(r.x + r.w + d); ys.add(r.y - d); ys.add(r.y + r.h + d); }
    xs.add(r.x + r.w / 2); ys.add(r.y + r.h / 2);
  }
  for (const p of extra) { xs.add(p.x); ys.add(p.y); }
  const tidy = (s: Set<number>) => [...s].map(v => Math.round(v * 2) / 2).sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1]! > 0.9);
  return { X: tidy(xs), Y: tidy(ys), obstacles };
}

const idx = (arr: number[], v: number) => {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]! < v - 0.9) lo = m + 1; else hi = m; }
  return lo;
};

type Blocked = (mid: Pt, i: number, j: number) => boolean;

/** A* from grid point s to t; `blocked(mid)` rejects a move whose midpoint is inside an obstacle. */
export function astar(grid: Grid, s: Pt, t: Pt, blocked: Blocked, used: Map<string, number> = new Map()): Pt[] | null {
  const { X, Y } = grid;
  const si = idx(X, s.x), sj = idx(Y, s.y), ti = idx(X, t.x), tj = idx(Y, t.y);
  const W = X.length, H = Y.length;
  const key = (i: number, j: number, d: number) => (i * H + j) * 4 + d;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const h = (i: number, j: number) => Math.abs(X[i]! - X[ti]!) + Math.abs(Y[j]! - Y[tj]!);
  const best = new Map<number, number>(), from = new Map<number, number>();
  type E = { i: number; j: number; d: number; g: number; f: number };
  const heap: E[] = [];
  const push = (e: E) => { heap.push(e); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p]!.f <= heap[k]!.f) break; [heap[p], heap[k]] = [heap[k]!, heap[p]!]; k = p; } };
  const pop = (): E => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < heap.length && heap[l]!.f < heap[m]!.f) m = l;
        if (r < heap.length && heap[r]!.f < heap[m]!.f) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!]; k = m;
      }
    }
    return top;
  };
  for (let d = 0; d < 4; d++) { best.set(key(si, sj, d), 0); push({ i: si, j: sj, d, g: 0, f: h(si, sj) }); }
  let endKey: number | null = null;
  while (heap.length) {
    const cur = pop();
    const ck = key(cur.i, cur.j, cur.d);
    if ((best.get(ck) ?? Infinity) < cur.g) continue;
    if (cur.i === ti && cur.j === tj) { endKey = ck; break; }
    for (let d = 0; d < 4; d++) {
      const ni = cur.i + DIRS[d]![0], nj = cur.j + DIRS[d]![1];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const mid = { x: (X[cur.i]! + X[ni]!) / 2, y: (Y[cur.j]! + Y[nj]!) / 2 };
      if (blocked(mid, ni, nj)) continue;
      const segKey = `${Math.min(cur.i, ni)},${Math.min(cur.j, nj)},${d < 2 ? 'h' : 'v'}`;
      const g = cur.g + Math.abs(X[ni]! - X[cur.i]!) + Math.abs(Y[nj]! - Y[cur.j]!)
        + (d !== cur.d && cur.g > 0 ? BEND : 0) + (used.get(segKey) ?? 0) * REUSE;
      const nk = key(ni, nj, d);
      if (g < (best.get(nk) ?? Infinity) - 1e-6) { best.set(nk, g); from.set(nk, ck); push({ i: ni, j: nj, d, g, f: g + h(ni, nj) }); }
    }
  }
  if (endKey === null) return null;
  const pts: Pt[] = [];
  for (let k: number | undefined = endKey; k !== undefined; k = from.get(k)) {
    const d = k % 4, cell = (k - d) / 4, j = cell % H, i = (cell - j) / H;
    pts.push({ x: X[i]!, y: Y[j]! });
  }
  pts.reverse();
  return simplify(pts);
}

/** Remember which grid segments a committed path occupies. */
export function markUsed(grid: Grid, pts: Pt[], used: Map<string, number>): void {
  const { X, Y } = grid;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!;
    const i0 = Math.min(idx(X, a.x), idx(X, b.x)), i1 = Math.max(idx(X, a.x), idx(X, b.x));
    const j0 = Math.min(idx(Y, a.y), idx(Y, b.y)), j1 = Math.max(idx(Y, a.y), idx(Y, b.y));
    if (Math.abs(a.y - b.y) < 0.01) for (let i = i0; i < i1; i++) { const sk = `${i},${j0},h`; used.set(sk, (used.get(sk) ?? 0) + 1); }
    else for (let j = j0; j < j1; j++) { const sk = `${i0},${j},v`; used.set(sk, (used.get(sk) ?? 0) + 1); }
  }
}

/** Drop repeated and collinear points. */
export function simplify(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) out.push({ ...p }); }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(i, 1);
  }
  return out;
}

/** Point on a node's side, and the same point pushed `M` outward. */
export function stub(n: Rect, side: Side): { on: Pt; out: Pt } {
  const c = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  const on = side === 'top' ? { x: c.x, y: n.y } : side === 'bottom' ? { x: c.x, y: n.y + n.h } : side === 'left' ? { x: n.x, y: c.y } : { x: n.x + n.w, y: c.y };
  const out = side === 'top' ? { x: c.x, y: n.y - M } : side === 'bottom' ? { x: c.x, y: n.y + n.h + M } : side === 'left' ? { x: n.x - M, y: c.y } : { x: n.x + n.w + M, y: c.y };
  return { on, out };
}

export interface RouteSpec { a: Rect; b: Rect; pref?: [Side, Side] }

/**
 * Route edges `{ a, b, pref }` around the rectangles `obstaclesFor(edge)`
 * returns. Preferred sides go first; when they only give a detour (more than
 * two bends) every side pair is tried and the cheapest wins. One polyline (or
 * null) per edge, in order.
 */
export function routeAll(edges: RouteSpec[], obstaclesFor: (e: RouteSpec) => Rect[]): (Pt[] | null)[] {
  const used = new Map<string, number>();
  const out: (Pt[] | null)[] = [];
  const order = (first: Side, all: Side[]) => [first, ...all.filter(x => x !== first)];
  for (const e of edges) {
    const obs = obstaclesFor(e);
    const blocked = (p: Pt) => obs.some(r => insideRect(p, r)) || insideRect(p, e.a) || insideRect(p, e.b);
    const sidesA = order(e.pref?.[0] ?? 'bottom', ['bottom', 'top', 'right', 'left']);
    const sidesB = order(e.pref?.[1] ?? 'top', ['top', 'bottom', 'left', 'right']);
    let best: { cost: number; pts: Pt[]; grid: Grid; path: Pt[] } | null = null;
    const trial = (sa: Side, sb: Side) => {
      const A = stub(e.a, sa), B = stub(e.b, sb);
      if (blocked(A.out) || blocked(B.out)) return;
      const grid = makeGrid([...obs, e.a, e.b], [A.out, B.out]);
      const path = astar(grid, A.out, B.out, blocked, used);
      if (!path) return;
      let cost = 0;
      for (let k = 1; k < path.length; k++) cost += Math.abs(path[k]!.x - path[k - 1]!.x) + Math.abs(path[k]!.y - path[k - 1]!.y);
      cost += (path.length - 2) * BEND + (sa !== sidesA[0] ? 40 : 0) + (sb !== sidesB[0] ? 40 : 0);
      if (!best || cost < best.cost) best = { cost, pts: simplify([A.on, ...path, B.on]), grid, path };
    };
    trial(sidesA[0]!, sidesB[0]!);
    if (!best || (best as { path: Pt[] }).path.length > 4)
      for (const sa of sidesA) for (const sb of sidesB) if (sa !== sidesA[0] || sb !== sidesB[0]) trial(sa, sb);
    if (best) { const b = best as { cost: number; pts: Pt[]; grid: Grid; path: Pt[] }; markUsed(b.grid, b.path, used); out.push(b.pts); }
    else out.push(null);
  }
  return out;
}

/** The plain two-bend route between two boxes — the fallback, and the live-drag router. */
export function routeSimple(a: Rect, b: Rect): Pt[] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx > 0 ? a.x + a.w : a.x, ex = dx > 0 ? b.x : b.x + b.w;
    const mid = (sx + ex) / 2;
    return simplify([{ x: sx, y: ay }, { x: mid, y: ay }, { x: mid, y: by }, { x: ex, y: by }]);
  }
  const sy = dy > 0 ? a.y + a.h : a.y, ey = dy > 0 ? b.y : b.y + b.h;
  const mid = (sy + ey) / 2;
  return simplify([{ x: ax, y: sy }, { x: ax, y: mid }, { x: bx, y: mid }, { x: bx, y: ey }]);
}

/**
 * Route one edge between two boxes around obstacles — what the canvas uses
 * while a card is being dragged. Falls back to the plain route when the
 * search finds nothing.
 */
export function routeAround(a: Rect, b: Rect, obstacles: Rect[]): Pt[] {
  const vertical = a.y + a.h <= b.y || b.y + b.h <= a.y;
  const down = a.y < b.y, right = a.x < b.x;
  const pref: [Side, Side] = vertical ? [down ? 'bottom' : 'top', down ? 'top' : 'bottom'] : [right ? 'right' : 'left', right ? 'left' : 'right'];
  const [p] = routeAll([{ a, b, pref }], () => obstacles.filter(o => o !== a && o !== b));
  return p ?? routeSimple(a, b);
}
