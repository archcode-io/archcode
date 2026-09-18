/**
 * Layout strategies under test. Each is `(g: RenderGraph, ctx) => Promise<Layout>`
 * where ctx = { layout, nodeBox, textWidth, target }.  Everything here is pure
 * JS on top of elkjs — the same code could run in the playground.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { makeGrid, astar, stub, simplify, routeAll, markUsed } from './router.mjs';
import { textWidth } from '../dist/src/layout/measure.js';

const elkOpts = root => (g, ctx) => ctx.layout(g, { root });

// ---------------------------------------------------------------- (a) ELK option variants
const ELK_VARIANTS = {
  'default': {},
  'elk-modelorder': {
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  },
  'elk-longestpath': { 'elk.layered.layering.strategy': 'LONGEST_PATH' },
  'elk-netsimplex': {
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  },
  'elk-linear': { 'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS' },
  'elk-bk-balanced': {
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
  },
  'elk-compact': {
    'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
    'elk.layered.compaction.postCompaction.constraints': 'SCANLINE',
    'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
  },
  'elk-tight': {
    'elk.layered.spacing.nodeNodeBetweenLayers': '40',
    'elk.spacing.nodeNode': '20',
    'elk.spacing.edgeNode': '14',
    'elk.spacing.edgeEdge': '10',
    'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  },
  'elk-cycle-model': { 'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER' },
  'elk-promote': { 'elk.layered.layering.nodePromotion.strategy': 'NIKOLOV' },
  'elk-thorough': { 'elk.layered.thoroughness': '200', 'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED' },
  'elk-right': { 'elk.direction': 'RIGHT' },
};

// ---------------------------------------------------------------- shared helpers
const bandOf = n => (n.kind === 'actor' ? 0 : n.kind === 'external' ? 2 : 1);
const cx = b => b.x + b.w / 2, cy = b => b.y + b.h / 2;
const idsUnder = n => { const out = [n.id]; const w = k => { for (const c of k.children) { out.push(c.id); w(c); } }; w(n); return out; };

/**
 * Lay out every top-level frame on its own (its internal edges only), and
 * measure every loose top-level card. Returns items in model order.
 */
const WRAP = t => ({ 'elk.partitioning.activate': 'false', 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': String(t), 'elk.layered.wrapping.additionalEdgeSpacing': '20', 'elk.layered.wrapping.multiEdge.improveCuts': 'true' });

async function layoutItems(g, ctx, frameDir = () => 'DOWN', extra = {}) {
  const items = [];
  for (const n of g.roots) {
    if (!n.children.length) {
      const box = ctx.nodeBox(n.label, n.tech, n.kind, n.meta);
      items.push({ node: n, id: n.id, kind: n.kind, band: bandOf(n), w: box.w, h: box.h, leaves: [n], members: [n], sub: null });
      continue;
    }
    const ids = new Set(idsUnder(n));
    const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    const dir = frameDir(n, edges);
    const sub = await ctx.layout({ roots: [n], edges }, { root: { 'elk.direction': dir, ...extra }, boundary: extra });
    const frame = sub.nodes.find(k => k.id === n.id);
    // normalise so the frame sits at (0,0)
    const ox = frame.x, oy = frame.y;
    for (const k of sub.nodes) { k.x -= ox; k.y -= oy; }
    for (const e of sub.edges) e.points = e.points.map(p => ({ x: p.x - ox, y: p.y - oy }));
    items.push({ node: n, id: n.id, kind: n.kind, band: 1, w: frame.w, h: frame.h, sub, members: sub.nodes, leaves: sub.nodes.filter(k => !k.isBoundary) });
  }
  return items;
}

/** Choose a frame's internal direction: whichever of DOWN / RIGHT lands nearest the target aspect. */
async function autoDir(n, edges, ctx) {
  let best = null;
  for (const dir of ['DOWN', 'RIGHT']) {
    const l = await ctx.layout({ roots: [n], edges }, { root: { 'elk.direction': dir } });
    const f = l.nodes.find(k => k.id === n.id);
    const err = Math.abs(Math.log2((f.w / f.h) / (ctx.target * (+process.env.FRAME_K || 1.3))));   // the outer rows add height
    if (!best || err < best.err) best = { dir, err };
  }
  return best.dir;
}

/**
 * Third parties are drawn at the bottom — unless they feed the system (called
 * by a person, or only calling in and never called): those read as upstream
 * and belong in the top row, or every call from them loops back up the page.
 */
function smartBands(items, g) {
  const itemOf = new Map();
  for (const it of items) for (const m of it.members) itemOf.set(m.id, it);
  for (const it of items) {
    if (it.kind !== 'external') continue;
    let fromActor = false, into = 0, outof = 0;
    for (const e of g.edges) {
      const A = itemOf.get(e.from), B = itemOf.get(e.to);
      if (B === it && A?.band === 0) fromActor = true;
      if (B === it && A?.band === 1) into++;
      if (A === it && B?.band === 1) outof++;
    }
    if (fromActor || (outof > 0 && into === 0)) it.band = 0;
  }
}

/** Absolute placement of an item's sub-layout at (x, y). */
function placeItem(it, x, y, out) {
  it.x = x; it.y = y;
  if (!it.sub) {
    const n = it.node;
    out.nodes.push({ id: n.id, kind: n.kind, label: n.label, tech: n.tech, meta: n.meta, ref: n.ref, phase: n.phase,
      transit: n.transit, external: n.external, x, y, w: it.w, h: it.h, depth: 0, isBoundary: false });
    return;
  }
  for (const k of it.sub.nodes) out.nodes.push({ ...k, x: k.x + x, y: k.y + y });
  for (const e of it.sub.edges) out.edges.push({ ...e, points: e.points.map(p => ({ x: p.x + x, y: p.y + y })),
    labelPos: e.labelPos ? { x: e.labelPos.x + x, y: e.labelPos.y + y } : undefined });
}

// ---------------------------------------------------------------- (b) band packing
const GAP_X = 40, GAP_Y = 36, BAND_GAP = 96;

/** Shelf-pack items (in the given order) into rows no wider than W. */
function shelf(items, W) {
  const rows = [];
  let row = [], rw = 0;
  for (const it of items) {
    const add = (row.length ? GAP_X : 0) + it.w;
    if (row.length && rw + add > W) { rows.push({ items: row, w: rw, h: Math.max(...row.map(i => i.h)) }); row = []; rw = 0; }
    row.push(it); rw += (row.length > 1 ? GAP_X : 0) + it.w;
  }
  if (row.length) rows.push({ items: row, w: rw, h: Math.max(...row.map(i => i.h)) });
  return rows;
}

/** Pack rows of items for a given width. The first and last band are people / third parties (BAND_GAP away). */
function packBands(bands, W) {
  const rowsPer = bands.map(b => shelf(b, W));
  const totalW = Math.max(1, ...rowsPer.flat().map(r => r.w));
  let y = 0;
  const placements = [];
  rowsPer.forEach((rows, bi) => {
    if (!rows.length) return;
    if (y > 0) y += (bi === 1 || bi === bands.length - 1) ? BAND_GAP : GAP_Y * 2;
    for (const r of rows) {
      let x = (totalW - r.w) / 2;              // centred rows read as balanced
      for (const it of r.items) {
        placements.push({ it, x, y: y + (r.h - it.h) / 2 });
        x += it.w + GAP_X;
      }
      y += r.h + GAP_Y;
    }
    y -= GAP_Y;
  });
  return { W: totalW, H: y, placements };
}

function barycenterOrder(items, ref, g) {
  const pos = new Map();
  for (const it of ref) for (const l of it.members) pos.set(l.id, it.x + (it.sub ? cx(l) : it.w / 2));
  const key = it => {
    const xs = [];
    for (const e of g.edges) {
      if (e.from === it.id && pos.has(e.to)) xs.push(pos.get(e.to));
      if (e.to === it.id && pos.has(e.from)) xs.push(pos.get(e.from));
    }
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
  };
  return items.map((it, i) => ({ it, k: key(it), i })).sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.it);
}

/**
 * Arrange items: middle band first at the width whose aspect lands nearest the
 * target, then people above / third parties below ordered by where their
 * partners ended up.
 */
/** Longest-path rank of the middle-band items over the item-level graph (cycles broken by model order). */
function rankItems(mid, g) {
  const itemOf = new Map();
  for (const it of mid) for (const m of it.members) itemOf.set(m.id, it);
  const index = new Map(mid.map((it, i) => [it.id, i]));
  const succ = new Map(mid.map(it => [it.id, new Set()]));
  for (const e of g.edges) {
    const A = itemOf.get(e.from), B = itemOf.get(e.to);
    if (!A || !B || A === B) continue;
    if (index.get(A.id) < index.get(B.id) || !succ.get(B.id).has(A.id)) succ.get(A.id).add(B.id);   // keep the first direction seen
  }
  const rank = new Map(), onStack = new Set();
  const visit = id => {
    if (rank.has(id)) return rank.get(id);
    if (onStack.has(id)) return 0;
    onStack.add(id);
    let r = 0;
    for (const t of succ.get(id)) r = Math.max(r, visit(t) + 1);
    onStack.delete(id); rank.set(id, r);
    return r;
  };
  for (const it of mid) visit(it.id);
  const maxR = Math.max(0, ...rank.values());
  return mid.map(it => ({ it, r: maxR - rank.get(it.id) }));   // sources on top
}

function arrange(items, g, target) {
  const mid = items.filter(i => i.band === 1), top = items.filter(i => i.band === 0), bot = items.filter(i => i.band === 2);
  const ranked = rankItems(mid, g);
  const rows = [];
  for (const { it, r } of ranked) (rows[r] ??= []).push(it);
  const midRows = rows.filter(Boolean);
  const widest = Math.max(1, ...items.map(i => i.w));
  const cands = new Set([widest]);
  for (const row of midRows) { let acc = 0; for (const it of row) { acc += (acc ? GAP_X : 0) + it.w; if (acc >= widest) cands.add(acc); } }
  let acc = 0; for (const it of mid) { acc += (acc ? GAP_X : 0) + it.w; if (acc >= widest) cands.add(acc); }
  const bands = W => [top, ...midRows, bot];
  let best = null;
  for (const W of [...cands].sort((a, b) => a - b)) {
    const p = packBands(bands(W), W, [1]);
    const err = Math.abs(Math.log2((p.W / Math.max(1, p.H)) / target));
    if (!best || err < best.err - 1e-9) best = { W, err };
  }
  let p = packBands([[], ...midRows, []], best.W, [1]);
  for (const { it, x, y } of p.placements) { it.x = x; it.y = y; }
  const topO = barycenterOrder(top, mid, g), botO = barycenterOrder(bot, mid, g);
  p = packBands([topO, ...midRows, botO], best.W, [1]);
  return p;
}

// ---------------------------------------------------------------- simple orthogonal router
/** canvas.js route(): the playground's live-drag router, verbatim. */
export function routeSimple(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx > 0 ? a.x + a.w : a.x, ex = dx > 0 ? b.x : b.x + b.w;
    const mid = (sx + ex) / 2;
    return [{ x: sx, y: ay }, { x: mid, y: ay }, { x: mid, y: by }, { x: ex, y: by }];
  }
  const sy = dy > 0 ? a.y + a.h : a.y, ey = dy > 0 ? b.y : b.y + b.h;
  const mid = (sy + ey) / 2;
  return [{ x: ax, y: sy }, { x: ax, y: mid }, { x: bx, y: mid }, { x: bx, y: ey }];
}

/** Is `side` of leaf `n` clear up to the border of its frame (no sibling in the way)? */
function sideFree(n, side, siblings) {
  for (const s of siblings) {
    if (s.id === n.id) continue;
    const xo = s.x < n.x + n.w && s.x + s.w > n.x, yo = s.y < n.y + n.h && s.y + s.h > n.y;
    if (side === 'top' && xo && s.y + s.h <= n.y + 1) return false;
    if (side === 'bottom' && xo && s.y >= n.y + n.h - 1) return false;
    if (side === 'left' && yo && s.x + s.w <= n.x + 1) return false;
    if (side === 'right' && yo && s.x >= n.x + n.w - 1) return false;
  }
  return true;
}

const dedupe = pts => {
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) out.push(p); }
  // drop collinear middles
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
  }
  return out;
};

/**
 * Route between two leaves that live in different top-level items. Leaves exit
 * and enter through a free side; the middle leg runs in the channel between
 * the items, one lane per edge.
 */
function routeSmart(a, b, itA, itB, sibA, sibB, lane) {
  const M = 16;   // clearance outside a frame border
  const vertical = itA.y + itA.h <= itB.y || itB.y + itB.h <= itA.y;
  const down = itA.y < itB.y;
  const pts = [];
  if (vertical) {
    const chan = down ? (itA.y + itA.h + itB.y) / 2 + lane : (itB.y + itB.h + itA.y) / 2 + lane;
    // exit
    const want = down ? 'bottom' : 'top';
    if (sideFree(a, want, sibA)) pts.push({ x: cx(a), y: down ? a.y + a.h : a.y }, { x: cx(a), y: chan });
    else {
      const side = (cx(b) < cx(a) && sideFree(a, 'left', sibA)) || !sideFree(a, 'right', sibA) ? 'left' : 'right';
      const outX = side === 'left' ? itA.x - M : itA.x + itA.w + M;
      pts.push({ x: side === 'left' ? a.x : a.x + a.w, y: cy(a) }, { x: outX, y: cy(a) }, { x: outX, y: chan });
    }
    // enter
    const wantB = down ? 'top' : 'bottom';
    if (sideFree(b, wantB, sibB)) pts.push({ x: cx(b), y: chan }, { x: cx(b), y: down ? b.y : b.y + b.h });
    else {
      const side = (cx(a) < cx(b) && sideFree(b, 'left', sibB)) || !sideFree(b, 'right', sibB) ? 'left' : 'right';
      const outX = side === 'left' ? itB.x - M : itB.x + itB.w + M;
      pts.push({ x: outX, y: chan }, { x: outX, y: cy(b) }, { x: side === 'left' ? b.x : b.x + b.w, y: cy(b) });
    }
  } else {
    const right = itA.x < itB.x;
    const chan = right ? (itA.x + itA.w + itB.x) / 2 + lane : (itB.x + itB.w + itA.x) / 2 + lane;
    const want = right ? 'right' : 'left';
    if (sideFree(a, want, sibA)) pts.push({ x: right ? a.x + a.w : a.x, y: cy(a) }, { x: chan, y: cy(a) });
    else {
      const side = (cy(b) < cy(a) && sideFree(a, 'top', sibA)) || !sideFree(a, 'bottom', sibA) ? 'top' : 'bottom';
      const outY = side === 'top' ? itA.y - M : itA.y + itA.h + M;
      pts.push({ x: cx(a), y: side === 'top' ? a.y : a.y + a.h }, { x: cx(a), y: outY }, { x: chan, y: outY });
    }
    const wantB = right ? 'left' : 'right';
    if (sideFree(b, wantB, sibB)) pts.push({ x: chan, y: cy(b) }, { x: right ? b.x : b.x + b.w, y: cy(b) });
    else {
      const side = (cy(a) < cy(b) && sideFree(b, 'top', sibB)) || !sideFree(b, 'bottom', sibB) ? 'top' : 'bottom';
      const outY = side === 'top' ? itB.y - M : itB.y + itB.h + M;
      pts.push({ x: chan, y: outY }, { x: cx(b), y: outY }, { x: cx(b), y: side === 'top' ? b.y : b.y + b.h });
    }
  }
  return dedupe(pts);
}

const TITLE_H = 44;
const underId = (id, f) => id !== f && (id.startsWith(f + '.') || id.startsWith(f + '/'));

/** Obstacles for an edge a→b: every other card, foreign frames whole, own frames' title strips. */
function obstaclesFor(nodes, a, b) {
  const obs = [];
  for (const n of nodes) {
    if (n.id === a.id || n.id === b.id) continue;
    if (!n.isBoundary) { obs.push(n); continue; }
    const holds = underId(a.id, n.id) || underId(b.id, n.id);
    if (holds) obs.push({ x: n.x, y: n.y, w: Math.min(n.w, 16 + textWidth(n.label, 13) * 1.08 + 10 + textWidth(`[${n.kind}]`, 9.5) + 16), h: 34 });   // the title text only
    else obs.push(n);
  }
  return obs;
}

function routeCross(out, items, g, mode = 'astar') {
  const byId = new Map(out.nodes.map(n => [n.id, n]));
  const itemOf = new Map();
  for (const it of items) for (const l of it.members) itemOf.set(l.id, it);
  const cross = g.edges.filter(e => itemOf.get(e.from) && itemOf.get(e.to) && itemOf.get(e.from) !== itemOf.get(e.to));
  const push = (e, pts) => out.edges.push({ from: e.from, to: e.to, label: e.label, verb: e.verb, derived: e.derived, dashed: e.dashed, points: pts });
  if (mode === 'astar') {
    // people first, then the rest in model order: earlier edges get the straighter lanes
    const order = cross.map((e, i) => ({ e, i, k: itemOf.get(e.from).band === 0 ? 0 : 1 })).sort((p, q) => p.k - q.k || p.i - q.i);
    const specs = order.map(({ e }) => {
      const a = byId.get(e.from), b = byId.get(e.to);
      const A = itemOf.get(e.from), B = itemOf.get(e.to);
      const vertical = A.y + A.h <= B.y || B.y + B.h <= A.y;
      const down = A.y < B.y, right = A.x < B.x;
      return { a, b, pref: vertical ? [down ? 'bottom' : 'top', down ? 'top' : 'bottom'] : [right ? 'right' : 'left', right ? 'left' : 'right'] };
    });
    const paths = routeAll(specs.map(sp => ({ a: sp.a, b: sp.b, sideA: undefined, sideB: undefined, pref: sp.pref })), sp => obstaclesFor(out.nodes, sp.a, sp.b));
    order.forEach(({ e }, i) => push(e, paths[i] ?? routeSimple(specs[i].a, specs[i].b)));
    return;
  }
  const chanKey = e => { const A = itemOf.get(e.from), B = itemOf.get(e.to); return [Math.min(A.band, B.band), Math.max(A.band, B.band), A.band === B.band ? 'h' : 'v'].join(':'); };
  const groups = new Map();
  for (const e of cross) (groups.get(chanKey(e)) ?? groups.set(chanKey(e), []).get(chanKey(e))).push(e);
  const laneOf = new Map();
  for (const es of groups.values()) {
    const sorted = es.map(e => ({ e, k: cx(byId.get(e.from)) + cx(byId.get(e.to)) })).sort((p, q) => p.k - q.k);
    sorted.forEach((s, i) => laneOf.set(s.e, (i - (sorted.length - 1) / 2) * 12));
  }
  for (const e of cross) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const A = itemOf.get(e.from), B = itemOf.get(e.to);
    const sib = (it, id) => it.sub ? out.nodes.filter(n => it.members.some(l => l.id === n.id) && n.id !== id && !id.startsWith(n.id + '.') && !n.id.startsWith(id + '.')) : [];
    const pts = mode === 'smart' ? routeSmart(a, b, A, B, sib(A, e.from), sib(B, e.to), laneOf.get(e)) : routeSimple(a, b);
    push(e, pts);
  }
}

function finish(out) {
  out.width = Math.max(0, ...out.nodes.map(n => n.x + n.w));
  out.height = Math.max(0, ...out.nodes.map(n => n.y + n.h));
  return out;
}

async function pack(g, ctx, { dir = 'DOWN', mode = 'astar', wrap = false, bands = 'smart' } = {}) {
  const frameDir = dir === 'AUTO' ? (n, es) => autoDir(n, es, ctx) : () => dir;
  const items = [];
  for (const n of g.roots) {   // autoDir is async, so unroll layoutItems
    if (!n.children.length) { items.push(...await layoutItems({ roots: [n], edges: [] }, ctx)); continue; }
    const ids = new Set(idsUnder(n));
    const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    const d = await frameDir(n, edges);
    items.push(...await layoutItems({ roots: [n], edges }, ctx, () => d, wrap ? WRAP(ctx.target * 1.3) : {}));
  }
  if (bands === 'smart') smartBands(items, g);
  const p = arrange(items, g, ctx.target);
  const out = { nodes: [], edges: [] };
  for (const { it, x, y } of p.placements) placeItem(it, x, y, out);
  routeCross(out, items, g, mode);
  return finish(out);
}

// ---------------------------------------------------------------- (e) two-phase ELK: frames as port-carrying nodes
async function twoPhase(g, ctx, { dir = 'DOWN', portMode = 'FIXED_POS', wrap = false, bands = 'smart' } = {}) {
  const items = [];
  for (const n of g.roots) {
    if (!n.children.length) { items.push(...await layoutItems({ roots: [n], edges: [] }, ctx)); continue; }
    const ids = new Set(idsUnder(n));
    const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    const d = dir === 'AUTO' ? await autoDir(n, edges, ctx) : dir;
    items.push(...await layoutItems({ roots: [n], edges }, ctx, () => d, wrap ? WRAP(ctx.target * 1.3) : {}));
  }
  if (bands === 'smart') smartBands(items, g);
  const itemOf = new Map();
  for (const it of items) for (const l of it.members) itemOf.set(l.id, it);
  const cross = g.edges.map((e, i) => ({ e, i })).filter(({ e }) => itemOf.get(e.from) && itemOf.get(e.to) && itemOf.get(e.from) !== itemOf.get(e.to));

  const ROOT = {
    'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.partitioning.activate': 'true',
    'elk.layered.spacing.nodeNodeBetweenLayers': '72', 'elk.spacing.nodeNode': '40',
    'elk.spacing.edgeNode': '18', 'elk.spacing.edgeEdge': '14', 'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.spacing.labelNode': '8', 'elk.spacing.edgeLabel': '6',
  };
  const elk = new ELK();
  const nodeOf = it => ({
    id: it.id, width: it.w, height: it.h,
    layoutOptions: {
      'elk.partitioning.partition': String(it.band),
      // people first, downstream third parties last; an upstream third party sits in
      // the top partition but must not be FIRST — ELK refuses an edge between two FIRST nodes
      ...(it.kind === 'actor' ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
      ...(it.band === 2 && it.kind === 'external' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : {}),
    },
  });
  // pass 1: no ports, learn who ends up above whom
  const g1 = { id: 'root', layoutOptions: ROOT, children: items.map(nodeOf),
    edges: cross.map(({ e, i }) => ({ id: `e${i}`, sources: [itemOf.get(e.from).id], targets: [itemOf.get(e.to).id] })) };
  const r1 = await elk.layout(g1);
  const pos1 = new Map(r1.children.map(c => [c.id, c]));

  // pass 2: fixed ports at the inner endpoint's coordinate on the facing border
  const ports = new Map(items.map(it => [it.id, []]));
  const portId = (it, leaf, side) => `${it.id}::${leaf}::${side}`;
  const portCount = new Map();
  const ensurePort = (it, leafId, side) => {
    const list = ports.get(it.id);
    const k = `${it.id}::${leafId}::${side}`;
    const n = (portCount.get(k) ?? 0); portCount.set(k, n + 1);
    const id = `${k}::${n}`;
    // several edges on one side of one card: spread them 12px apart, deterministically by edge order
    const off = (n - 0) * 12 * (n % 2 ? 1 : -1) * Math.ceil(n / 2) / Math.max(1, n);
    const spread = n === 0 ? 0 : (n % 2 ? 1 : -1) * 12 * Math.ceil(n / 2);
    void off;
    if (!it.sub) { list.push({ id, side, x: (side === 'left' ? 0 : side === 'right' ? it.w : it.w / 2) + (side === 'left' || side === 'right' ? 0 : spread), y: (side === 'top' ? 0 : side === 'bottom' ? it.h : it.h / 2) + (side === 'top' || side === 'bottom' ? 0 : spread) }); return id; }
    const leaf = it.members.find(l => l.id === leafId);
    // a top port under the frame's title text would have to snake around it: start right of the title
    const titleW = 16 + textWidth(it.node.label, 13) * 1.08 + 10 + textWidth(`[${it.kind}]`, 9.5) + 24;
    list.push({ id, side,
      x: side === 'left' ? 0 : side === 'right' ? it.w : (side === 'top' ? Math.max(cx(leaf), titleW) : cx(leaf)) + spread,
      y: side === 'top' ? 0 : side === 'bottom' ? it.h : cy(leaf) + spread });
    return id;
  };
  const sideFor = (from, to) => {
    const A = pos1.get(from.id), B = pos1.get(to.id);
    if (A.y + A.height <= B.y) return ['bottom', 'top'];
    if (B.y + B.height <= A.y) return ['top', 'bottom'];
    return A.x < B.x ? ['right', 'left'] : ['left', 'right'];
  };
  /** The wanted side, unless a sibling blocks it — then the free side facing the partner. */
  const freeSide = (it, leafId, want, other) => {
    if (!it.sub) return want;
    const leaf = it.members.find(l => l.id === leafId);
    const sib = it.members.filter(n => n.id !== leafId && !leafId.startsWith(n.id + '.') && !n.id.startsWith(leafId + '.'));
    if (sideFree(leaf, want, sib)) return want;
    const P = pos1.get(it.id), Q = pos1.get(other.id);
    const alt = want === 'top' || want === 'bottom'
      ? (Q.x + Q.width / 2 < P.x + P.width / 2 ? ['left', 'right'] : ['right', 'left'])
      : (Q.y + Q.height / 2 < P.y + P.height / 2 ? ['top', 'bottom'] : ['bottom', 'top']);
    for (const s of alt) if (sideFree(leaf, s, sib)) return s;
    return want;
  };
  const edges2 = cross.map(({ e, i }) => {
    const A = itemOf.get(e.from), B = itemOf.get(e.to);
    const [wa, wb] = sideFor(A, B);
    const sa = freeSide(A, e.from, wa, B), sb = freeSide(B, e.to, wb, A);
    return { id: `e${i}`, sources: [ensurePort(A, e.from, sa)], targets: [ensurePort(B, e.to, sb)],
      labels: e.label ? [{ text: e.label, width: ctx.textWidth(e.label, 10) + 8, height: 14 }] : [] };
  });
  const SIDE = { top: 'NORTH', bottom: 'SOUTH', left: 'WEST', right: 'EAST' };
  const g2 = { id: 'root', layoutOptions: ROOT, edges: edges2,
    children: items.map(it => ({ ...nodeOf(it),
      layoutOptions: { ...nodeOf(it).layoutOptions, 'elk.portConstraints': portMode },
      ports: ports.get(it.id).map(p => ({ id: p.id, width: 1, height: 1, x: p.x - 0.5, y: p.y - 0.5, layoutOptions: { 'elk.port.side': SIDE[p.side] } })) })) };
  const r2 = await elk.layout(g2);
  const out = { nodes: [], edges: [] };
  const pos = new Map(r2.children.map(c => [c.id, c]));
  for (const it of items) { const c = pos.get(it.id); placeItem(it, c.x, c.y, out); }
  const byId = new Map(out.nodes.map(n => [n.id, n]));
  const framesById = new Map(items.filter(it => it.sub).map(it => [it.id, it]));
  const used = new Map();
  /** Inner leg: from the border port to the leaf, around the frame's other members. */
  const leg = (it, leafId, p) => {
    const n = byId.get(leafId);
    const frame = byId.get(it.id);
    const obs = obstaclesFor(out.nodes.filter(k => it.members.some(m => m.id === k.id)), n, n);
    const inFrame = q => q.x >= frame.x - 1 && q.x <= frame.x + frame.w + 1 && q.y >= frame.y - 1 && q.y <= frame.y + frame.h + 1;
    const blocked = q => !inFrame(q) || obs.some(r => q.x > r.x + 0.5 && q.x < r.x + r.w - 0.5 && q.y > r.y + 0.5 && q.y < r.y + r.h - 0.5) || (q.x > n.x + 0.5 && q.x < n.x + n.w - 0.5 && q.y > n.y + 0.5 && q.y < n.y + n.h - 0.5);
    let best = null;
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const st = stub(n, side);
      if (blocked(st.out)) continue;
      const grid = makeGrid([...obs, n], [p, st.out]);
      const path = astar(grid, p, st.out, blocked, new Map(used));
      if (!path) continue;
      let cost = 0; for (let k = 1; k < path.length; k++) cost += Math.abs(path[k].x - path[k - 1].x) + Math.abs(path[k].y - path[k - 1].y) + 70;
      if (!best || cost < best.cost) best = { cost, pts: [...path, st.on], side, grid, out: st.out };
    }
    if (!best) { const st = stub(n, p.y <= n.y ? 'top' : p.y >= n.y + n.h ? 'bottom' : p.x < n.x ? 'left' : 'right'); return [p, { x: st.on.x, y: p.y }, st.on]; }
    markUsed(best.grid, best.pts, used);
    return best.pts;
  };
  for (const e2 of r2.edges ?? []) {
    const src = g.edges[+e2.id.slice(1)];
    const sec = e2.sections?.[0];
    if (!sec) continue;
    const sa = e2.sources[0].split('::')[2], sb = e2.targets[0].split('::')[2];
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
    const A = itemOf.get(src.from), B = itemOf.get(src.to);
    const head = A.sub ? leg(A, src.from, pts[0]).reverse() : [pts[0]];
    const tail = B.sub ? leg(B, src.to, pts[pts.length - 1]) : [pts[pts.length - 1]];
    void sa; void sb;
    out.edges.push({ from: src.from, to: src.to, label: src.label, verb: src.verb, derived: src.derived, dashed: src.dashed,
      points: simplify([...head.slice(0, -1), ...pts, ...tail.slice(1)]) });
  }
  return finish(out);
}

// ---------------------------------------------------------------- (d) grid snap + chain alignment post-pass
const PAD = { x: 26, top: 46, bottom: 26 };
function hugFrames(l) {
  const depth = id => (id.match(/[./]/g) ?? []).length;
  const under = (k, f) => k.id !== f.id && (k.id.startsWith(f.id + '.') || k.id.startsWith(f.id + '/'));
  for (const f of l.nodes.filter(n => n.isBoundary).sort((a, b) => depth(b.id) - depth(a.id))) {
    const inner = l.nodes.filter(k => under(k, f));
    if (!inner.length) continue;
    const x = Math.min(...inner.map(k => k.x)) - PAD.x, y = Math.min(...inner.map(k => k.y)) - PAD.top;
    f.x = x; f.y = y;
    f.w = Math.max(...inner.map(k => k.x + k.w)) + PAD.x - x;
    f.h = Math.max(...inner.map(k => k.y + k.h)) + PAD.bottom - y;
  }
}

function snap(l, grid = 12) {
  const leaves = l.nodes.filter(n => !n.isBoundary);
  const moved = new Map();
  const shift = (n, dx, dy) => {
    if (!dx && !dy) return;
    n.x += dx; n.y += dy;
    const m = moved.get(n.id) ?? { dx: 0, dy: 0 }; moved.set(n.id, { dx: m.dx + dx, dy: m.dy + dy });
  };
  for (const n of leaves) shift(n, Math.round(n.x / grid) * grid - n.x, Math.round(n.y / grid) * grid - n.y);
  // chains: a node with one in-edge from a node with one out-edge shares its centre line
  const outDeg = new Map(), inDeg = new Map();
  for (const e of l.edges) { outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1); inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1); }
  const byId = new Map(l.nodes.map(n => [n.id, n]));
  const overlaps = (a, b) => a.x < b.x + b.w + 16 && a.x + a.w + 16 > b.x && a.y < b.y + b.h + 12 && a.y + a.h + 12 > b.y;
  for (const e of l.edges) {
    if (outDeg.get(e.from) !== 1 || inDeg.get(e.to) !== 1) continue;
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a.isBoundary || b.isBoundary) continue;
    const d = cx(a) - cx(b);
    if (Math.abs(d) < 0.5 || Math.abs(d) > 60) continue;
    const trial = { ...b, x: b.x + d };
    if (leaves.some(o => o !== b && overlaps(trial, o))) continue;
    shift(b, d, 0);
  }
  // drag the ends of ELK's orthogonal polylines along
  for (const e of l.edges) {
    const p = e.points; if (p.length < 2) continue;
    const ma = moved.get(e.from), mb = moved.get(e.to);
    if (ma) { const v = p[0].x === p[1].x; p[0].x += ma.dx; p[0].y += ma.dy; if (v) p[1].x += ma.dx; else p[1].y += ma.dy; }
    if (mb) { const k = p.length - 1, v = p[k].x === p[k - 1].x; p[k].x += mb.dx; p[k].y += mb.dy; if (v) p[k - 1].x += mb.dx; else p[k - 1].y += mb.dy; }
  }
  hugFrames(l);
  return finish(l);
}

// ---------------------------------------------------------------- registry
import { layoutTwoPhase } from '../dist/src/layout/balance.js';

export const STRATEGIES = {
  'engine': (g, ctx) => layoutTwoPhase(g, { target: ctx.target }),
  ...Object.fromEntries(Object.entries(ELK_VARIANTS).map(([k, v]) => [k, elkOpts(v)])),
  'snap': async (g, ctx) => snap(await ctx.layout(g)),
  'pack-down': (g, ctx) => pack(g, ctx, { dir: 'DOWN' }),
  'pack-right': (g, ctx) => pack(g, ctx, { dir: 'RIGHT' }),
  'pack-auto': (g, ctx) => pack(g, ctx, { dir: 'AUTO' }),
  'pack-smart': (g, ctx) => pack(g, ctx, { dir: 'AUTO', mode: 'smart' }),
  'pack-simple': (g, ctx) => pack(g, ctx, { dir: 'AUTO', mode: 'simple' }),
  'pack-auto-snap': async (g, ctx) => snap(await pack(g, ctx, { dir: 'AUTO' })),
  'elk2-down': (g, ctx) => twoPhase(g, ctx, { dir: 'DOWN' }),
  'elk2-auto': (g, ctx) => twoPhase(g, ctx, { dir: 'AUTO' }),
  'elk2-side': (g, ctx) => twoPhase(g, ctx, { dir: 'AUTO', portMode: 'FIXED_SIDE' }),
  'elk2-wrap': (g, ctx) => twoPhase(g, ctx, { dir: 'RIGHT', wrap: true }),
  'elk2-auto-c4strict': (g, ctx) => twoPhase(g, ctx, { dir: 'AUTO', bands: 'strict' }),
  'elk2-wrapdown': (g, ctx) => twoPhase(g, ctx, { dir: 'DOWN', wrap: true }),
  'pack-wrap': (g, ctx) => pack(g, ctx, { dir: 'RIGHT', wrap: true }),
};
