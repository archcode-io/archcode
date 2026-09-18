/**
 * Small obstacle-aware orthogonal router (Hanan grid + A* with a bend penalty).
 *
 * Grid lines are drawn at every obstacle border ± clearance (two lanes), plus
 * the endpoints; a move along a grid line is legal when its midpoint is not
 * inside an obstacle. Deterministic: ties broken by insertion order. A shared
 * `used` map makes later edges prefer lanes nobody has taken yet.
 */
export const M = 16, LANE = 14, BEND = 70, REUSE = 40;

const insideRect = (p, r, eps = 0.5) => p.x > r.x + eps && p.x < r.x + r.w - eps && p.y > r.y + eps && p.y < r.y + r.h - eps;

export function makeGrid(obstacles, extra = []) {
  const xs = new Set(), ys = new Set();
  for (const r of obstacles) {
    for (const d of [M, M + LANE]) { xs.add(r.x - d); xs.add(r.x + r.w + d); ys.add(r.y - d); ys.add(r.y + r.h + d); }
    xs.add(r.x + r.w / 2); ys.add(r.y + r.h / 2);
  }
  for (const p of extra) { xs.add(p.x); ys.add(p.y); }
  const X = [...xs].map(v => Math.round(v * 2) / 2).sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 0.9);
  const Y = [...ys].map(v => Math.round(v * 2) / 2).sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 0.9);
  return { X, Y, obstacles };
}

const idx = (arr, v) => { let lo = 0, hi = arr.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v - 0.9) lo = m + 1; else hi = m; } return lo; };

/** A* from grid point s to t; `blocked(mid)` rejects a move whose midpoint is inside an obstacle. */
export function astar(grid, s, t, blocked, used = new Map()) {
  const { X, Y } = grid;
  const si = idx(X, s.x), sj = idx(Y, s.y), ti = idx(X, t.x), tj = idx(Y, t.y);
  const W = X.length, H = Y.length;
  const key = (i, j, d) => (i * H + j) * 4 + d;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const h = (i, j) => Math.abs(X[i] - X[ti]) + Math.abs(Y[j] - Y[tj]);
  const best = new Map(), from = new Map();
  const heap = [];
  const push = e => { heap.push(e); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p].f <= heap[k].f) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  for (let d = 0; d < 4; d++) { best.set(key(si, sj, d), 0); push({ i: si, j: sj, d, g: 0, f: h(si, sj) }); }
  let endKey = null;
  while (heap.length) {
    const cur = pop();
    const ck = key(cur.i, cur.j, cur.d);
    if ((best.get(ck) ?? Infinity) < cur.g) continue;
    if (cur.i === ti && cur.j === tj) { endKey = ck; break; }
    for (let d = 0; d < 4; d++) {
      const ni = cur.i + DIRS[d][0], nj = cur.j + DIRS[d][1];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const mid = { x: (X[cur.i] + X[ni]) / 2, y: (Y[cur.j] + Y[nj]) / 2 };
      if (blocked(mid, ni, nj)) continue;
      const segKey = `${Math.min(cur.i, ni)},${Math.min(cur.j, nj)},${d < 2 ? 'h' : 'v'}`;
      const g = cur.g + Math.abs(X[ni] - X[cur.i]) + Math.abs(Y[nj] - Y[cur.j]) + (d !== cur.d && cur.g > 0 ? BEND : 0) + (used.get(segKey) ?? 0) * REUSE;
      const nk = key(ni, nj, d);
      if (g < (best.get(nk) ?? Infinity) - 1e-6) { best.set(nk, g); from.set(nk, ck); push({ i: ni, j: nj, d, g, f: g + h(ni, nj) }); }
    }
  }
  if (endKey === null) return null;
  const pts = [];
  for (let k = endKey; k !== undefined; k = from.get(k)) { const d = k % 4, cell = (k - d) / 4, j = cell % H, i = (cell - j) / H; pts.push({ x: X[i], y: Y[j] }); }
  pts.reverse();
  return simplify(pts);
}

/** Remember which grid segments a committed path occupies. */
export function markUsed(grid, pts, used) {
  const { X, Y } = grid;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const i0 = Math.min(idx(X, a.x), idx(X, b.x)), i1 = Math.max(idx(X, a.x), idx(X, b.x));
    const j0 = Math.min(idx(Y, a.y), idx(Y, b.y)), j1 = Math.max(idx(Y, a.y), idx(Y, b.y));
    if (Math.abs(a.y - b.y) < 0.01) for (let i = i0; i < i1; i++) { const sk = `${i},${j0},h`; used.set(sk, (used.get(sk) ?? 0) + 1); }
    else for (let j = j0; j < j1; j++) { const sk = `${i0},${j},v`; used.set(sk, (used.get(sk) ?? 0) + 1); }
  }
}

export function simplify(pts) {
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) out.push({ ...p }); }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(i, 1);
  }
  return out;
}

/** Point on a node's side, and the same point pushed `M` outward. */
export function stub(n, side) {
  const c = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  const on = side === 'top' ? { x: c.x, y: n.y } : side === 'bottom' ? { x: c.x, y: n.y + n.h } : side === 'left' ? { x: n.x, y: c.y } : { x: n.x + n.w, y: c.y };
  const out = side === 'top' ? { x: c.x, y: n.y - M } : side === 'bottom' ? { x: c.x, y: n.y + n.h + M } : side === 'left' ? { x: n.x - M, y: c.y } : { x: n.x + n.w + M, y: c.y };
  return { on, out };
}

/**
 * Route a set of edges { a, b, pref: [sideA, sideB] } against the rectangles
 * `obstaclesFor(edge)` returns. The preferred sides are tried first; when they
 * only give a detour (more than 2 bends) every side pair is tried and the
 * cheapest wins. Returns one polyline (or null) per edge, in order.
 */
export function routeAll(edges, obstaclesFor) {
  const used = new Map();
  const out = [];
  const order = (first, all) => [first, ...all.filter(x => x !== first)];
  for (const e of edges) {
    const obs = obstaclesFor(e);
    const blocked = p => obs.some(r => insideRect(p, r)) || insideRect(p, e.a) || insideRect(p, e.b);
    const sidesA = order(e.pref?.[0] ?? 'bottom', ['bottom', 'top', 'right', 'left']);
    const sidesB = order(e.pref?.[1] ?? 'top', ['top', 'bottom', 'left', 'right']);
    let best = null;
    const trial = (sa, sb) => {
      const A = stub(e.a, sa), B = stub(e.b, sb);
      if (blocked(A.out) || blocked(B.out)) return;
      const grid = makeGrid([...obs, e.a, e.b], [A.out, B.out]);
      const path = astar(grid, A.out, B.out, blocked, used);
      if (!path) return;
      let cost = 0; for (let k = 1; k < path.length; k++) cost += Math.abs(path[k].x - path[k - 1].x) + Math.abs(path[k].y - path[k - 1].y);
      cost += (path.length - 2) * BEND + (sa !== sidesA[0] ? 40 : 0) + (sb !== sidesB[0] ? 40 : 0);
      if (!best || cost < best.cost) best = { cost, pts: simplify([A.on, ...path, B.on]), grid, path };
    };
    trial(sidesA[0], sidesB[0]);
    if (!best || best.path.length > 4)
      for (const sa of sidesA) for (const sb of sidesB) if (sa !== sidesA[0] || sb !== sidesB[0]) trial(sa, sb);
    if (best) { markUsed(best.grid, best.path, used); out.push(best.pts); }
    else out.push(null);
  }
  return out;
}
