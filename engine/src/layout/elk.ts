import { footerOf, AGENT_MIN_W, type RenderGraph, type RenderNode } from '../lens.js';
import { elkInstance } from './host.js';
import { nodeBox, textWidth } from './measure.js';

export interface Positioned {
  id: string; kind: string; label: string; tech?: string; meta?: string; ref?: string; phase?: string; load?: string; over?: boolean; agents?: string[]; stage?: string;
  transit: boolean; external: boolean;
  x: number; y: number; w: number; h: number; depth: number; isBoundary: boolean;
}

export interface RoutedEdge {
  from: string; to: string; label?: string; verb: string;
  derived: boolean; dashed: boolean;
  points: { x: number; y: number }[];
  labelPos?: { x: number; y: number };
  /** Where along the route (0…1 by length) the label sits when nothing else placed it — a person dragged it there. */
  labelAt?: number;
  /** The label on the other side of the line (below / left) — a person put it there. */
  labelFlip?: boolean;
}

export interface Layout { nodes: Positioned[]; edges: RoutedEdge[]; width: number; height: number }

/**
 * Reading order: people at the top, your systems in the middle, third parties
 * at the bottom. This is how every hand-drawn C4 context diagram is arranged,
 * and ELK will not discover it on its own.
 */
function partitionOf(n: RenderNode): number | undefined {
  if (n.kind === 'actor') return 0;
  if (n.kind === 'external') return 2;
  return 1;   // transit is deliberately NOT pinned: pinning it manufactures
              // back-edges that then have to crawl around the whole diagram
}

/**
 * Top to bottom, the way a C4 picture is read: people on top, the system in
 * the middle, third parties at the bottom. A left-to-right layering of the
 * same graphs came out 4–7 times wider than tall — unreadable at "fit" on a
 * landscape screen; top-down lands near 0.6–0.7 and the datastore clusters
 * already stack downwards. Spacing is deliberately tight: the six reference
 * architectures measured 12–15 % ink at the wider values.
 */
const ROOT_OPTS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.partitioning.activate': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '14',
  'elk.layered.spacing.edgeNodeBetweenLayers': '22',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.thoroughness': '70',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  // NOTE: elk.layered.wrapping is incompatible with partitioning — enabling it
  // throws inside ELK. Narrowing wide diagrams needs a different lever.
  'elk.aspectRatio': '1.7',
  'elk.spacing.labelNode': '8',
  'elk.spacing.edgeLabel': '6',
};

const BOUNDARY_OPTS: Record<string, string> = {
  'elk.padding': '[top=48,left=26,bottom=26,right=26]',
  'elk.spacing.nodeNode': '26',
  'elk.layered.spacing.nodeNodeBetweenLayers': '50',
};

/**
 * A store belongs beside the service that owns it.
 *
 * In a plain left-to-right layered graph a datastore lands in the next column,
 * far from its service and often past three unrelated boxes. Putting the owner
 * and its stores into an invisible group keeps them adjacent and makes the
 * `writes` edge short. (A strict "directly below" would need the group laid out
 * separately, which ELK refuses to mix with INCLUDE_CHILDREN.)
 */
const CLUSTER_OPTS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': '26',
  'elk.layered.spacing.nodeNodeBetweenLayers': '30',
};

const STORAGE = new Set(['datastore', 'cache']);

/** Title strip height: a meta line that cannot sit beside the title in a 300px frame wraps under it. */
function headOf(n: RenderNode): number {
  if (!n.meta) return 48;
  const need = 16 + textWidth(n.label, 13) * 1.08 + 10 + textWidth(`[${n.kind}]`, 9.5) + 24 + textWidth(n.meta, 10) * 1.2 + 14;
  return need > 300 ? 62 : 48;
}

export interface LayoutOptions {
  /** ELK options merged over the root defaults — the layout experiments live here. */
  root?: Record<string, string>;
  boundary?: Record<string, string>;
}

/** The single-pass layered layout — used inside frames by the two-phase layout, and as an escape hatch. */
export async function layoutLayered(g: RenderGraph, opts: LayoutOptions = {}): Promise<Layout> {
  const rootOpts = { ...ROOT_OPTS, ...(opts.root ?? {}) };
  const boundaryOpts = { ...BOUNDARY_OPTS, ...(opts.boundary ?? {}) };
  const elk = await elkInstance();

  // ---- index the source tree ----
  const meta = new Map<string, RenderNode>();
  const parentOf = new Map<string, string | undefined>();
  const index = (ns: RenderNode[], parent?: string) => {
    for (const n of ns) { meta.set(n.id, n); parentOf.set(n.id, parent); index(n.children, n.id); }
  };
  index(g.roots);

  // ---- pull each store under the single service that owns it ----
  const clusterOf = new Map<string, string>();     // storeId -> ownerId
  {
    const writers = new Map<string, Set<string>>();
    for (const e of g.edges) {
      const to = meta.get(e.to);
      if (!to || !STORAGE.has(to.kind)) continue;
      (writers.get(e.to) ?? writers.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    for (const [id, n] of meta) {
      if (!STORAGE.has(n.kind)) continue;
      const declared = n.ownedBy;
      const inferred = writers.get(id)?.size === 1 ? [...writers.get(id)!][0] : undefined;
      const owner = declared ?? inferred;
      if (!owner || !meta.has(owner)) continue;
      if (parentOf.get(owner) !== parentOf.get(id)) continue;   // same container only
      // An owner that is itself a frame (a service opened to its components)
      // cannot host a cluster: the store would be cut out of its parent and
      // never placed anywhere. It stays a plain neighbour instead.
      if (meta.get(owner)!.children.length) continue;
      clusterOf.set(id, owner);
    }
    // The cluster becomes a real level of the hierarchy, so the owner→store
    // edge lands inside it: that single edge is what makes ELK stack the store
    // beneath its service instead of parking it in the next column.
    const owners = new Set(clusterOf.values());
    for (const owner of owners) {
      const cid = `__cluster__${owner}`;
      parentOf.set(cid, parentOf.get(owner));   // once per owner, before rebinding
      parentOf.set(owner, cid);
    }
    for (const [store, owner] of clusterOf) parentOf.set(store, `__cluster__${owner}`);
  }

  const chain = (id: string): string[] => {
    const out: string[] = [];
    let cur: string | undefined = id;
    while (cur !== undefined) { out.unshift(cur); cur = parentOf.get(cur); }
    return out;
  };

  /**
   * Attach every edge to the lowest container that holds both endpoints.
   * ELK reports edge coordinates relative to the edge's own container, so
   * placing edges by hand is what makes the offsets predictable — reading
   * them from a flat root list gives mixed coordinate frames.
   */
  const lca = (a: string, b: string): string | undefined => {
    const ca = chain(a), cb = chain(b);
    let last: string | undefined;
    for (let i = 0; i < Math.min(ca.length, cb.length) - 0; i++) {
      if (ca[i] === cb[i] && (i < ca.length - 1) && (i < cb.length - 1)) last = ca[i];
      else break;
    }
    return last;
  };

  const edgesByContainer = new Map<string, any[]>();
  g.edges.forEach((e, i) => {
    const c = lca(e.from, e.to) ?? '__root__';
    const arr = edgesByContainer.get(c) ?? [];
    arr.push({
      id: `e${i}`, sources: [e.from], targets: [e.to],
      labels: e.label ? [{ text: e.label, width: textWidth(e.label, 10) + 8, height: 14 }] : [],
    });
    edgesByContainer.set(c, arr);
  });

  const plain = (n: RenderNode): any => {
    const boundary = n.children.length > 0;
    const box = nodeBox(n.label, n.tech, n.kind, n.meta, n.agents);
    const part = partitionOf(n);
    return {
      id: n.id,
      ...(boundary ? {} : { width: box.w, height: box.h }),
      layoutOptions: {
        ...(boundary ? boundaryOpts : {}),
        // a frame with agent chips along its bottom needs the footer row below its members
        ...(boundary && (footerOf(n) || headOf(n) > 48) ? { 'elk.padding': `[top=${headOf(n)},left=26,bottom=${26 + footerOf(n)},right=26]` } : {}),
        // the footer was sized for a frame at least this wide; hold the frame open to it
        // (ELK transposes the graph for DOWN/UP and forgets to transpose this option — so we do)
        ...(boundary && footerOf(n) ? { 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': /DOWN|UP/.test(rootOpts['elk.direction'] ?? '') ? `(0, ${AGENT_MIN_W})` : `(${AGENT_MIN_W}, 0)` } : {}),
        ...(part !== undefined && parentOf.get(n.id) === undefined ? { 'elk.partitioning.partition': String(part) } : {}),
        // people share the first row and third parties the last one, whatever
        // the edges would prefer — the picture is read top to bottom
        ...(parentOf.get(n.id) === undefined && n.kind === 'actor' ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
        ...(parentOf.get(n.id) === undefined && n.kind === 'external' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : {}),
      },
      children: n.children.filter(c => !clusterOf.has(c.id)).map(toElk),
      edges: edgesByContainer.get(n.id) ?? [],
      labels: boundary ? [{ text: n.label, width: textWidth(n.label, 13), height: 18 }] : [],
    };
  };

  const toElk = (n: RenderNode): any => {
    const owned = [...clusterOf.entries()].filter(([, o]) => o === n.id).map(([s]) => s);
    if (!owned.length || n.children.length) return plain(n);
    return {
      id: `__cluster__${n.id}`,
      layoutOptions: CLUSTER_OPTS,
      children: [plain(n), ...owned.map(id => plain(meta.get(id)!))],
      edges: edgesByContainer.get(`__cluster__${n.id}`) ?? [],
      labels: [],
    };
  };

  const graph = {
    id: 'root',
    layoutOptions: rootOpts,
    children: g.roots.filter(n => !clusterOf.has(n.id)).map(toElk),
    edges: edgesByContainer.get('__root__') ?? [],
  };

  const res = await elk.layout(graph);

  const nodes: Positioned[] = [];
  const abs = new Map<string, { x: number; y: number }>();
  const walkNodes = (children: any[], ox: number, oy: number, depth: number) => {
    for (const c of children) {
      const x = ox + (c.x ?? 0), y = oy + (c.y ?? 0);
      abs.set(c.id, { x, y });
      if (String(c.id).startsWith('__cluster__')) { walkNodes(c.children ?? [], x, y, depth); continue; }
      const m = meta.get(c.id);
      nodes.push({
        id: c.id, kind: m?.kind ?? '', label: m?.label ?? c.id, tech: m?.tech, meta: m?.meta, ref: m?.ref, phase: m?.phase, load: m?.load, over: m?.over, agents: m?.agents, stage: m?.stage,
        transit: m?.transit ?? false, external: m?.external ?? false,
        x, y, w: c.width ?? 0, h: c.height ?? 0, depth,
        isBoundary: (c.children?.length ?? 0) > 0,
      });
      if (c.children?.length) walkNodes(c.children, x, y, depth + 1);
    }
  };
  walkNodes(res.children ?? [], 0, 0, 0);

  const edges: RoutedEdge[] = [];
  const walkEdges = (n: any, ox: number, oy: number) => {
    for (const e of n.edges ?? []) {
      const src = g.edges[Number(String(e.id).slice(1))];
      if (!src) continue;
      const sec = e.sections?.[0];
      const pts = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
      const lbl = e.labels?.[0];
      edges.push({
        from: src.from, to: src.to, label: src.label, verb: src.verb,
        derived: src.derived, dashed: src.dashed,
        points: pts.map((p: any) => ({ x: p.x + ox, y: p.y + oy })),
        labelPos: lbl ? { x: (lbl.x ?? 0) + ox, y: (lbl.y ?? 0) + oy } : undefined,
      });
    }
    for (const c of n.children ?? []) {
      const a = abs.get(c.id) ?? { x: ox + (c.x ?? 0), y: oy + (c.y ?? 0) };
      walkEdges(c, a.x, a.y);
    }
  };
  walkEdges(res, 0, 0);

  return { nodes, edges, width: res.width ?? 0, height: res.height ?? 0 };
}

import { layoutTwoPhase, type BalanceOptions } from './balance.js';

/**
 * The default layout: two-phase (frames on their own, then the top level with
 * ports) — see balance.ts for why. `strategy: 'layered'` gives the old single
 * pass.
 */
export async function layout(g: RenderGraph, opts: LayoutOptions & BalanceOptions & { strategy?: 'two-phase' | 'layered' } = {}): Promise<Layout> {
  if (opts.strategy === 'layered' || opts.root || opts.boundary) return layoutLayered(g, opts);
  return layoutTwoPhase(g, opts);
}
