/**
 * Two-phase layout — how the reference decks are actually drawn.
 *
 * One layered layout over the whole tree (ELK `INCLUDE_CHILDREN`) stretches
 * every system across every layer of the picture: tall empty frames, 10–15 %
 * ink, aspect 0.4–0.8. Measured on the six reference architectures nothing in
 * ELK's option space moves that by more than one point. What does is doing what
 * a person does: lay out each system on its own, then arrange the systems.
 *
 *   1. every top-level frame is laid out separately, top-down or left-to-right —
 *      whichever lands nearer the target aspect;
 *   2. the top level is laid out again with frames as opaque nodes carrying
 *      fixed ports on the border facing each partner (people first, downstream
 *      third parties last);
 *   3. the leg from a port to the card inside is routed around the frame's other
 *      members and its title text.
 *
 * Deterministic, ~150 ms on the references, and it scores 53 against 39 for the
 * single pass (aspect 1.3–2.2, no edge through a card).
 */
import { footerOf, type RenderGraph, type RenderNode, type RenderEdge } from '../lens.js';
import { layoutLayered, type Layout, type LayoutOptions, type Positioned, type RoutedEdge } from './elk.js';
import { elkInstance } from './host.js';
import { nodeBox, textWidth } from './measure.js';
import { makeGrid, astar, stub, simplify, markUsed, routeSimple, type Pt, type Rect, type Side } from './route.js';

export interface BalanceOptions {
  /** Width ÷ height the picture should approach (the canvas, or 16:9). */
  target?: number;
  /** Direction inside every frame; `auto` picks per frame by the target aspect. */
  dir?: 'auto' | 'DOWN' | 'RIGHT';
  /** Wrap long chains inside frames (ELK multi-edge wrapping) — for very long pipelines. */
  wrap?: boolean;
}

interface Item {
  node: RenderNode; id: string; kind: string; band: number;
  w: number; h: number;
  sub: Layout | null;                     // the frame's own layout, normalised to (0,0)
  members: Positioned[];                  // everything inside, frames included
  x: number; y: number;
}

const bandOf = (n: RenderNode) => (n.kind === 'actor' ? 0 : n.kind === 'external' ? 2 : 1);
const cx = (b: Rect) => b.x + b.w / 2, cy = (b: Rect) => b.y + b.h / 2;
const idsUnder = (n: RenderNode): string[] => { const out = [n.id]; const w = (k: RenderNode) => { for (const c of k.children) { out.push(c.id); w(c); } }; w(n); return out; };
const underId = (id: string, f: string) => id !== f && (id.startsWith(f + '.') || id.startsWith(f + '/'));
const TITLE_H = 34;

const WRAP = (t: number): Record<string, string> => ({
  'elk.partitioning.activate': 'false', 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': String(t),
  'elk.layered.wrapping.additionalEdgeSpacing': '20', 'elk.layered.wrapping.multiEdge.improveCuts': 'true',
});

/** Lay one frame out on its own and normalise it to (0, 0). */
async function frameItem(n: RenderNode, edges: RenderEdge[], dir: 'DOWN' | 'RIGHT', extra: Record<string, string>): Promise<Item> {
  const sub = await layoutLayered({ roots: [n], edges }, { root: { 'elk.direction': dir, ...extra }, boundary: extra });
  const frame = sub.nodes.find(k => k.id === n.id)!;
  const ox = frame.x, oy = frame.y;
  for (const k of sub.nodes) { k.x -= ox; k.y -= oy; }
  for (const e of sub.edges) {
    e.points = e.points.map(p => ({ x: p.x - ox, y: p.y - oy }));
    if (e.labelPos) e.labelPos = { x: e.labelPos.x - ox, y: e.labelPos.y - oy };
  }
  return { node: n, id: n.id, kind: n.kind, band: 1, w: frame.w, h: frame.h, sub, members: sub.nodes, x: 0, y: 0 };
}

/**
 * Top-down unless the frame comes out a tower. Top-down is how a system is
 * read — a service above the store it writes, a caller above the callee — and
 * it keeps every service–store edge one row long. Left-to-right lands the store
 * three columns away and was chosen only for its aspect; it is kept for the
 * long pipelines whose top-down picture is more than twice as tall as wide.
 */
async function autoDir(n: RenderNode, edges: RenderEdge[], target: number): Promise<'DOWN' | 'RIGHT'> {
  const down = await layoutLayered({ roots: [n], edges }, { root: { 'elk.direction': 'DOWN' } });
  const fd = down.nodes.find(k => k.id === n.id)!;
  if (fd.w / fd.h >= 0.5) return 'DOWN';
  const right = await layoutLayered({ roots: [n], edges }, { root: { 'elk.direction': 'RIGHT' } });
  const fr = right.nodes.find(k => k.id === n.id)!;
  const err = (w: number, h: number) => Math.abs(Math.log2((w / h) / (target * 1.3)));
  return err(fr.w, fr.h) + 0.5 < err(fd.w, fd.h) ? 'RIGHT' : 'DOWN';
}

/**
 * Third parties are drawn at the bottom — unless they feed the system (called
 * by a person, or only calling in and never called): those read as upstream
 * and belong in the top row, or every call from them loops back up the page.
 */
function smartBands(items: Item[], g: RenderGraph): void {
  const itemOf = new Map<string, Item>();
  for (const it of items) { itemOf.set(it.id, it); for (const m of it.members) itemOf.set(m.id, it); }
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

/** Is `side` of leaf `n` clear up to the border of its frame (no sibling in the way)? */
function sideFree(n: Rect & { id: string }, side: Side, siblings: (Rect & { id: string })[]): boolean {
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

/** Obstacles for a leg inside a frame: every other card whole, nested frames' title strips. */
export function obstaclesFor(nodes: Positioned[], a: Positioned, b: Positioned): Rect[] {
  const obs: Rect[] = [];
  for (const n of nodes) {
    if (n.id === a.id || n.id === b.id) continue;
    if (!n.isBoundary) { obs.push(n); continue; }
    const holds = underId(a.id, n.id) || underId(b.id, n.id);
    if (holds) {
      obs.push({ x: n.x, y: n.y, w: Math.min(n.w, 16 + textWidth(n.label, 13) * 1.08 + 10 + textWidth(`[${n.kind}]`, 9.5) + 16), h: TITLE_H });
      const footer = footerOf(n);
      if (footer) obs.push({ x: n.x, y: n.y + n.h - footer - 6, w: n.w, h: footer + 6 });   // the agent chips along the bottom
    }
    else obs.push(n);
  }
  return obs;
}

const TOP_OPTS: Record<string, string> = {
  'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
  'elk.partitioning.activate': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72', 'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '18', 'elk.spacing.edgeEdge': '14', 'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.spacing.labelNode': '8', 'elk.spacing.edgeLabel': '6',
};

export async function layoutTwoPhase(g: RenderGraph, opts: BalanceOptions = {}): Promise<Layout> {
  const target = opts.target ?? 1.6;
  const dirOpt = opts.dir ?? 'auto';

  // ---- phase 1: every top-level thing becomes an item ----
  const items: Item[] = [];
  for (const n of g.roots) {
    if (!n.children.length) {
      const box = nodeBox(n.label, n.tech, n.kind, n.meta, n.agents);
      items.push({ node: n, id: n.id, kind: n.kind, band: bandOf(n), w: box.w, h: box.h, sub: null, members: [], x: 0, y: 0 });
      continue;
    }
    const ids = new Set(idsUnder(n));
    const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    const dir = dirOpt === 'auto' ? await autoDir(n, edges, target) : dirOpt;
    items.push(await frameItem(n, edges, dir, opts.wrap ? WRAP(target * 1.3) : {}));
  }
  if (!items.length) return { nodes: [], edges: [], width: 0, height: 0 };
  smartBands(items, g);

  const itemOf = new Map<string, Item>();
  for (const it of items) {
    itemOf.set(it.id, it);
    for (const m of it.members) itemOf.set(m.id, it);
  }
  const cross = g.edges.map((e, i) => ({ e, i })).filter(({ e }) => itemOf.get(e.from) && itemOf.get(e.to) && itemOf.get(e.from) !== itemOf.get(e.to));

  const elk = await elkInstance();
  const nodeOf = (it: Item) => ({
    id: it.id, width: it.w, height: it.h,
    layoutOptions: {
      'elk.partitioning.partition': String(it.band),
      // people first, downstream third parties last; an upstream third party sits in
      // the top partition but must not be FIRST — ELK refuses an edge between two FIRST nodes
      ...(it.kind === 'actor' ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
      ...(it.band === 2 && it.kind === 'external' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : {}),
    } as Record<string, string>,
  });

  // ---- pass 1: no ports — learn who ends up above whom ----
  const r1 = await elk.layout({
    id: 'root', layoutOptions: TOP_OPTS, children: items.map(nodeOf),
    edges: cross.map(({ e, i }) => ({ id: `e${i}`, sources: [itemOf.get(e.from)!.id], targets: [itemOf.get(e.to)!.id] })),
  });
  const pos1 = new Map<string, any>(r1.children.map((c: any) => [c.id, c]));

  // ---- pass 2: fixed ports at the inner endpoint's coordinate on the facing border ----
  const ports = new Map<string, { id: string; side: Side; x: number; y: number }[]>(items.map(it => [it.id, []]));
  const portCount = new Map<string, number>();
  const ensurePort = (it: Item, leafId: string, side: Side): string => {
    const list = ports.get(it.id)!;
    const k = `${it.id}::${leafId}::${side}`;
    const n = portCount.get(k) ?? 0; portCount.set(k, n + 1);
    const id = `${k}::${n}`;
    // several edges on one side of one card: spread them 12px apart, deterministically by edge order
    const spread = n === 0 ? 0 : (n % 2 ? 1 : -1) * 12 * Math.ceil(n / 2);
    const horizontal = side === 'left' || side === 'right';
    if (!it.sub) {
      list.push({ id, side, x: (side === 'left' ? 0 : side === 'right' ? it.w : it.w / 2) + (horizontal ? 0 : spread),
                  y: (side === 'top' ? 0 : side === 'bottom' ? it.h : it.h / 2) + (horizontal ? spread : 0) });
      return id;
    }
    const leaf = it.members.find(l => l.id === leafId)!;
    // a top port under the frame's title text would have to snake around it: start right of the title
    const titleW = 16 + textWidth(it.node.label, 13) * 1.08 + 10 + textWidth(`[${it.kind}]`, 9.5) + 24;
    list.push({ id, side,
      x: side === 'left' ? 0 : side === 'right' ? it.w : (side === 'top' ? Math.max(cx(leaf), titleW) : cx(leaf)) + spread,
      y: side === 'top' ? 0 : side === 'bottom' ? it.h : cy(leaf) + spread });
    return id;
  };
  const sideFor = (from: Item, to: Item): [Side, Side] => {
    const A = pos1.get(from.id), B = pos1.get(to.id);
    if (A.y + A.height <= B.y) return ['bottom', 'top'];
    if (B.y + B.height <= A.y) return ['top', 'bottom'];
    return A.x < B.x ? ['right', 'left'] : ['left', 'right'];
  };
  /** The wanted side, unless a sibling blocks it — then the free side facing the partner. */
  const freeSide = (it: Item, leafId: string, want: Side, other: Item): Side => {
    if (!it.sub) return want;
    const leaf = it.members.find(l => l.id === leafId)!;
    const sib = it.members.filter(n => n.id !== leafId && !leafId.startsWith(n.id + '.') && !n.id.startsWith(leafId + '.'));
    if (sideFree(leaf, want, sib)) return want;
    const P = pos1.get(it.id), Q = pos1.get(other.id);
    const alt: Side[] = want === 'top' || want === 'bottom'
      ? (Q.x + Q.width / 2 < P.x + P.width / 2 ? ['left', 'right'] : ['right', 'left'])
      : (Q.y + Q.height / 2 < P.y + P.height / 2 ? ['top', 'bottom'] : ['bottom', 'top']);
    for (const s of alt) if (sideFree(leaf, s, sib)) return s;
    return want;
  };
  const edges2 = cross.map(({ e, i }) => {
    const A = itemOf.get(e.from)!, B = itemOf.get(e.to)!;
    const [wa, wb] = sideFor(A, B);
    const sa = freeSide(A, e.from, wa, B), sb = freeSide(B, e.to, wb, A);
    return { id: `e${i}`, sources: [ensurePort(A, e.from, sa)], targets: [ensurePort(B, e.to, sb)],
      labels: e.label ? [{ text: e.label, width: textWidth(e.label, 10) + 8, height: 14 }] : [] };
  });
  const SIDE: Record<Side, string> = { top: 'NORTH', bottom: 'SOUTH', left: 'WEST', right: 'EAST' };
  const r2 = await elk.layout({
    id: 'root', layoutOptions: TOP_OPTS, edges: edges2,
    children: items.map(it => ({ ...nodeOf(it),
      layoutOptions: { ...nodeOf(it).layoutOptions, 'elk.portConstraints': 'FIXED_POS' },
      ports: ports.get(it.id)!.map(p => ({ id: p.id, width: 1, height: 1, x: p.x - 0.5, y: p.y - 0.5, layoutOptions: { 'elk.port.side': SIDE[p.side] } })) })),
  });

  // ---- place ----
  const out: Layout = { nodes: [], edges: [], width: 0, height: 0 };
  const pos = new Map<string, any>(r2.children.map((c: any) => [c.id, c]));
  for (const it of items) { const c = pos.get(it.id); it.x = c.x; it.y = c.y; }

  // ---- straighten: a card whose every arrow leaves vertically towards one x slides under (or
  // over) that port, so the line is a line and not a line with a 14px jog in it. ELK places the
  // card by its centre and the port by the leaf inside the frame; the two rarely coincide.
  const shifted = new Set<string>();
  {
    const portOf = (it: Item, pid: string) => ports.get(it.id)!.find(p => p.id === pid)!;
    for (const it of items) {
      if (it.sub) continue;
      const mine = edges2.filter(e => e.sources[0]!.startsWith(it.id + '::') || e.targets[0]!.startsWith(it.id + '::'));
      if (!mine.length) continue;
      let dx: number | null = null, ok = true;
      for (const e of mine) {
        const meSrc = e.sources[0]!.startsWith(it.id + '::');
        const myPid = meSrc ? e.sources[0]! : e.targets[0]!, otherPid = meSrc ? e.targets[0]! : e.sources[0]!;
        const other = items.find(k => otherPid.startsWith(k.id + '::'))!;
        const mp = portOf(it, myPid), op = portOf(other, otherPid);
        const vertical = (q: Side) => q === 'top' || q === 'bottom';
        if (!vertical(mp.side) || !vertical(op.side)) { ok = false; break; }
        const d = (other.x + op.x) - (it.x + mp.x);
        if (dx === null) dx = d; else if (Math.abs(d - dx) > 1) { ok = false; break; }
      }
      if (!ok || dx === null || Math.abs(dx) < 1 || Math.abs(dx) > 90) continue;
      const nx = it.x + dx;
      const clash = items.some(k => k !== it && k.y < it.y + it.h + 24 && k.y + k.h > it.y - 24 && k.x < nx + it.w + 24 && k.x + k.w > nx - 24);
      if (clash || nx < 0) continue;
      it.x = nx; shifted.add(it.id);
    }
  }

  for (const it of items) {
    const c = { x: it.x, y: it.y };
    if (!it.sub) {
      const n = it.node;
      out.nodes.push({ id: n.id, kind: n.kind, label: n.label, tech: n.tech, meta: n.meta, ref: n.ref, phase: n.phase, load: n.load, over: n.over, agents: n.agents, stage: n.stage,
        transit: n.transit, external: n.external, x: c.x, y: c.y, w: it.w, h: it.h, depth: 0, isBoundary: false });
      continue;
    }
    for (const k of it.sub.nodes) out.nodes.push({ ...k, x: k.x + c.x, y: k.y + c.y });
    for (const e of it.sub.edges) out.edges.push({ ...e, points: e.points.map(p => ({ x: p.x + c.x, y: p.y + c.y })),
      labelPos: e.labelPos ? { x: e.labelPos.x + c.x, y: e.labelPos.y + c.y } : undefined });
  }
  const byId = new Map(out.nodes.map(n => [n.id, n]));
  const used = new Map<string, number>();

  /** Inner leg: from the border port to the leaf, around the frame's other members. */
  const leg = (it: Item, leafId: string, p: Pt): Pt[] => {
    const n = byId.get(leafId)!;
    const frame = byId.get(it.id)!;
    const obs = obstaclesFor(out.nodes.filter(k => it.members.some(m => m.id === k.id)), n, n);
    const inFrame = (q: Pt) => q.x >= frame.x - 1 && q.x <= frame.x + frame.w + 1 && q.y >= frame.y - 1 && q.y <= frame.y + frame.h + 1;
    const inside = (q: Pt, r: Rect) => q.x > r.x + 0.5 && q.x < r.x + r.w - 0.5 && q.y > r.y + 0.5 && q.y < r.y + r.h - 0.5;
    const blocked = (q: Pt) => !inFrame(q) || obs.some(r => inside(q, r)) || inside(q, n);
    let best: { cost: number; pts: Pt[]; grid: ReturnType<typeof makeGrid> } | null = null;
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const st = stub(n, side);
      if (blocked(st.out)) continue;
      const grid = makeGrid([...obs, n], [p, st.out]);
      const path = astar(grid, p, st.out, blocked, new Map(used));
      if (!path) continue;
      let cost = 0;
      for (let k = 1; k < path.length; k++) cost += Math.abs(path[k]!.x - path[k - 1]!.x) + Math.abs(path[k]!.y - path[k - 1]!.y) + 70;
      if (!best || cost < best.cost) best = { cost, pts: [...path, st.on], grid };
    }
    if (!best) {
      const st = stub(n, p.y <= n.y ? 'top' : p.y >= n.y + n.h ? 'bottom' : p.x < n.x ? 'left' : 'right');
      return [p, { x: st.on.x, y: p.y }, st.on];
    }
    markUsed(best.grid, best.pts, used);
    return best.pts;
  };
  for (const e2 of r2.edges ?? []) {
    const src = g.edges[+String(e2.id).slice(1)]!;
    const sec = e2.sections?.[0];
    if (!sec) continue;
    let pts: Pt[] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
    const A = itemOf.get(src.from)!, B = itemOf.get(src.to)!;
    let straightened = false;
    if (shifted.has(A.id) || shifted.has(B.id)) {
      // the card moved under its port: the top-level leg is now one vertical line
      const pa = ports.get(A.id)!.find(p => p.id === e2.sources[0])!, pb = ports.get(B.id)!.find(p => p.id === e2.targets[0])!;
      const p0 = { x: A.x + pa.x, y: A.y + pa.y }, p1 = { x: B.x + pb.x, y: B.y + pb.y };
      pts = Math.abs(p0.x - p1.x) < 1 ? [p0, { x: p0.x, y: p1.y }] : [p0, { x: p0.x, y: (p0.y + p1.y) / 2 }, { x: p1.x, y: (p0.y + p1.y) / 2 }, p1];
      straightened = true;
    }
    const head = A.sub ? leg(A, src.from, pts[0]!).reverse() : [pts[0]!];
    const tail = B.sub ? leg(B, src.to, pts[pts.length - 1]!) : [pts[pts.length - 1]!];
    const lbl = e2.labels?.[0];
    const edge: RoutedEdge = { from: src.from, to: src.to, label: src.label, verb: src.verb, derived: src.derived, dashed: src.dashed,
      points: simplify([...head.slice(0, -1), ...pts, ...tail.slice(1)]),
      labelPos: lbl && lbl.x !== undefined && !straightened ? { x: lbl.x, y: lbl.y } : undefined };
    out.edges.push(edge);
  }
  // an edge the top pass could not route (should not happen) still gets a line
  const routed = new Set(out.edges.map(e => `${e.from}>${e.to}>${e.verb}>${e.label ?? ''}`));
  for (const e of g.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || routed.has(`${e.from}>${e.to}>${e.verb}>${e.label ?? ''}`)) continue;
    out.edges.push({ from: e.from, to: e.to, label: e.label, verb: e.verb, derived: e.derived, dashed: e.dashed, points: routeSimple(a, b) });
  }
  out.width = Math.max(0, ...out.nodes.map(n => n.x + n.w));
  out.height = Math.max(0, ...out.nodes.map(n => n.y + n.h));
  return out;
}
