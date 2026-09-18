import type { Model, ModelObject, ModelRelation } from './model.js';
import { PLACEMENT_KINDS } from './vocab.js';
import { effectiveSizing, hostLoad } from './capacity.js';

/** Render-time views over the model. Nothing here is ever written back (D-52). */

export type Lens = 'logical' | 'infrastructure';

/**
 * A lens is not a mode — it is a **preset for one set**: which transit nodes are
 * expanded. `logical` starts with none, `infrastructure` with all, and `shown`
 * / `hidden` move individual nodes in and out. Everything downstream reads that
 * single set, so a chip and the lens switch can never disagree, and no edge is
 * ever produced twice or lost.
 */
export interface LensOptions {
  lens: Lens;
  shown?: string[];      // expand these even in the logical lens
  hidden?: string[];     // collapse these even in the infrastructure lens
  collapsed?: string[];  // systems shown as a single box (C1) instead of opened (C2)
  /**
   * Which picture (spec §16.1): `model` draws the C4 objects; `deployment`
   * draws environments, segments and nodes with the objects that run in them.
   */
  kind?: 'model' | 'deployment';
  /**
   * Which architecture: an object or relation carrying `phase X` belongs to
   * variant X only; anything without a phase belongs to every variant.
   * Undefined draws everything.
   */
  phase?: string;
  /** Draw the agents installed on hosts as chips on the deployment picture (default on). */
  agents?: boolean;
}

export interface RenderNode {
  id: string; kind: string; label: string; tech?: string;
  /** For a placement card: the logical object it stands for. */
  ref?: string;
  /** `phase transit` — this thing exists in that variant only (spec §6.5). */
  phase?: string;
  /** For a host frame: `cpu 6/16 · mem 4/32Gi`, and whether demand exceeds it. */
  load?: string;
  over?: boolean;
  /** One short line of figures worth seeing on the card: `×3 · 2 cpu · 4Gi`. */
  meta?: string;
  /** For a host frame: the agents installed on it (`agent antivirus, alloy`) — drawn as chips along the bottom. */
  agents?: string[];
  /** `stage sketch|proposed|approved|live|deprecated|retired` (§17.4): sketch and proposed draw dashed, deprecated dimmed, retired is not drawn. */
  stage?: string;
  /** A collapsed system: how many objects it folds. */
  folded?: number;
  transit: boolean; external: boolean; ownedBy?: string; children: RenderNode[];
}

/** Space a frame's footer needs below its members: one row of agent chips is 22px. */
export const AGENT_ROW = 22;
/** A frame with agents is held open to at least this width, so the row count decided before layout holds after it. */
export const AGENT_MIN_W = 240;
export function footerOf(n: { agents?: string[]; w?: number; isBoundary?: boolean }): number {
  if (!n.agents?.length) return 0;
  const width = n.agents.reduce((a, s) => a + s.length * 6 + 18, 0);
  // a frame is held open to AGENT_MIN_W by the layout; a plain card is as wide as it is
  const usable = (n.isBoundary === false && n.w ? n.w : Math.max(AGENT_MIN_W, n.w ?? AGENT_MIN_W)) - 28;
  return AGENT_ROW * Math.max(1, Math.ceil(width / usable));
}

/**
 * The card shows what a reader of a sizing table would look for first —
 * replicas, cpu, memory, disk, gpu, capacity — and nothing else. Every other
 * attribute stays in the text and in the inspector.
 */
export function metaLine(attrs: Record<string, string[]>): string | undefined {
  const bits: string[] = [];
  const one = (k: string) => attrs[k]?.join(' ');
  const count = one('replicas') ?? one('count') ?? one('nodes');
  if (count) bits.push(`×${count}`);
  if (one('cpu')) bits.push(`${one('cpu')} cpu`);
  if (one('mem')) bits.push(`${one('mem')}`);
  const disk = attrs['disk'];
  if (disk?.length) bits.push(`${disk.filter(v => /\d/.test(v)).join('+')} disk`);   // `disk system 30Gi data 200Gi` → 30Gi+200Gi
  if (one('gpu')) bits.push(`gpu ${one('gpu')}`);
  const cap = attrs['capacity'];
  if (cap?.length) {
    const pairs: string[] = [];
    for (let i = 0; i + 1 < cap.length; i += 2) pairs.push(`${cap[i]} ${cap[i + 1]}`);
    bits.push(pairs.join(' · ') || cap.join(' '));
  }
  return bits.length ? bits.join(' · ') : undefined;
}

export interface RenderEdge {
  from: string; to: string; verb: string; label?: string;
  derived: boolean;                 // computed by the lens, absent from the file
  folded?: boolean;                 // an end was folded into a collapsed system
  dashed: boolean;
}

export interface RenderGraph { roots: RenderNode[]; edges: RenderEdge[] }

const isTransit = (o: ModelObject) => 'transit' in o.attrs;
// Frames: things that are drawn as an area holding other things. A system
// holds containers; the placement blocks hold what runs where.
const BOUNDARY = new Set(['system', 'env', 'cluster', 'managed', 'segment', 'node']);
const TRANSPARENT = new Set(['arch']);   // document root, not a drawn boundary

/**
 * Blocks that describe the document rather than the system. They belong to the
 * model, but drawing them as boxes is meaningless — a `view` is the picture,
 * not a thing in the picture.
 */
const NOT_DRAWN = new Set(['view', 'board', 'decision', 'rule', 'profile']);

/**
 * Resolve a reference the way a reader would: innermost scope first, then
 * outwards, then the bare id (D-48).
 */
function resolve(ref: string, scope: string | undefined, m: Model): string {
  if (m.objects.has(ref)) return ref;
  let s = scope;
  while (s) {
    const cand = `${s}.${ref}`;
    if (m.objects.has(cand)) return cand;
    const dot = s.lastIndexOf('.');
    s = dot < 0 ? undefined : s.slice(0, dot);
  }
  for (const key of m.objects.keys()) if (key.endsWith(`.${ref}`)) return key;
  return ref;
}

const scopeOf = (id: string, m: Model) => m.objects.get(id)?.parent;

export function applyLens(m: Model, opt: Lens | LensOptions): RenderGraph {
  const o: LensOptions = typeof opt === 'string' ? { lens: opt } : opt;
  const lens = o.lens;

  // ---- the one set everything downstream depends on ----
  const transitIds = [...m.objects.values()].filter(isTransit).map(x => x.id);
  const matches = (id: string, name: string) =>
    id === name || (m.objects.get(id)?.localId ?? '') === name;
  /**
   * A collapsed system is drawn as one box and everything inside it is folded
   * away — this is the C1 ⇄ C2 move. Connections to its members re-point to the
   * system itself, so the picture stays true: the outside world really does
   * talk to that system, it just does not need to see through it right now.
   */
  // The same move one level down folds a container to its C2 box (C2 ⇄ C3).
  // Anything that has members can be folded; a leaf has nothing to hide.
  const hasMembers = new Set<string>();
  for (const ob of m.objects.values()) if (ob.parent) hasMembers.add(ob.parent);
  const collapsedSystems = new Set<string>();
  for (const name of o.collapsed ?? [])
    for (const [id, ob] of m.objects)
      if (hasMembers.has(id) && (id === name || ob.localId === name)) collapsedSystems.add(id);

  const foldInto = (id: string): string => {
    for (const sys of collapsedSystems) if (id !== sys && id.startsWith(sys + '.')) return sys;
    return id;
  };

  const expanded = new Set<string>(lens === 'infrastructure' ? transitIds : []);
  for (const name of o.shown ?? [])
    for (const id of transitIds) if (matches(id, name)) expanded.add(id);
  for (const name of o.hidden ?? [])
    for (const id of transitIds) if (matches(id, name)) expanded.delete(id);

  // ---- phase: transit vs target on one model ----
  const inPhase = (attrs: Record<string, string[]>) =>
    !o.phase || !attrs['phase']?.length || attrs['phase'].includes(o.phase);
  const offPhase = new Set<string>();
  if (o.phase) for (const [id, ob] of m.objects) if (!inPhase(ob.attrs)) offPhase.add(id);
  const phased = (id: string) => { for (const off of offPhase) if (id === off || id.startsWith(off + '.')) return true; return false; };

  // ---- resolve every relation endpoint once ----
  type R = ModelRelation & { fromId: string; toId: string };
  const rels: R[] = m.relations.filter(r => inPhase(r.attrs)).map(r => ({
    ...r,
    fromId: resolve(r.from, scopeOf(r.from, m) ?? r.from, m),
    toId: resolve(r.to, m.objects.get(r.from) ? scopeOf(r.from, m) : undefined, m),
  })).filter(r => !phased(r.fromId) && !phased(r.toId));

  if (o.kind === 'deployment') return deploymentGraph(m, rels, inPhase, phased, o.agents !== false);

  const topics = new Map<string, ModelObject>();
  for (const [id, o] of m.objects) if (o.kind === 'topic') topics.set(id, o);

  const hidden = new Set<string>();
  const edges: RenderEdge[] = [];

  const push = (rawFrom: string, rawTo: string, verb: string, label: string | undefined, derived: boolean) => {
    const from = foldInto(rawFrom), to = foldInto(rawTo);
    if (!from || !to || from === to) return;
    const folded = from !== rawFrom || to !== rawTo;
    if (!folded && edges.some(e => e.from === from && e.to === to && e.verb === verb && e.label === label)) return;
    edges.push({ from, to, verb, label, derived, dashed: derived, folded });
  };

  /**
   * Relations that fold into a collapsed system become one aggregated, visibly
   * derived edge per pair (§17.2): the shared verb when they agree, a count and
   * no verb when they do not. A relation declared at that level stands on its
   * own and takes the count.
   */
  const aggregate = (): RenderEdge[] => {
    const out: RenderEdge[] = [];
    const groups = new Map<string, RenderEdge[]>();
    for (const e of edges) {
      if (!e.folded) { out.push(e); continue; }
      const k = `${e.from}\u0000${e.to}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    for (const g of groups.values()) {
      const { from, to } = g[0]!;
      const explicit = out.find(e => e.from === from && e.to === to && !e.folded);
      const n = g.length;
      if (explicit) { if (n > 1 || explicit.verb !== g[0]!.verb) explicit.label = [explicit.label, `×${n} inside`].filter(Boolean).join(' · '); continue; }
      const verbs = new Set(g.map(e => e.verb));
      if (verbs.size === 1) out.push({ from, to, verb: g[0]!.verb, label: n > 1 ? `×${n}` : g[0]!.label, derived: true, dashed: true, folded: true });
      else out.push({ from, to, verb: 'relates', label: `${n} relations`, derived: true, dashed: true, folded: true });
    }
    return out;
  };

  for (const r of rels) {
    const viaIds = (r.via ?? []).map(v => resolve(v, scopeOf(r.from, m), m));
    const drawn = viaIds.filter(v => expanded.has(v));
    const folded = viaIds.filter(v => !expanded.has(v));

    // Hops that are expanded become real segments; the rest fold into the label.
    // A chain can be partly expanded — that is the whole point of point overrides.
    const foldedLabel = folded.length
      ? `via ${folded.map(v => m.objects.get(v)?.localId ?? v).join(' → ')}` : undefined;
    const label = [r.label ?? r.over, foldedLabel].filter(Boolean).join(' · ') || undefined;

    if (drawn.length) {
      const hops = [r.fromId, ...drawn, r.toId];
      for (let i = 0; i < hops.length - 1; i++)
        push(hops[i]!, hops[i + 1]!, r.verb, i === 0 ? label : undefined, true);
    } else {
      push(r.fromId, r.toId, r.verb, label, false);
    }
  }

  // ---- topics are channels, not boxes on a canvas ----
  //
  // A topic has a passport of its own, but on a C4 container diagram people draw
  // either the broker between two services (infrastructure) or a single dashed
  // arrow labelled with the event (logical). Drawing a topic box does neither,
  // so the topic node is dropped from both lenses and its edges are derived.
  for (const [tid, t] of topics) {
    const pubs = new Set<string>();
    const subs = new Set<string>();
    for (const r of rels) {
      if (r.toId !== tid) continue;
      if (r.verb === 'publishes') pubs.add(r.fromId);
      if (r.verb === 'subscribes') subs.add(r.fromId);
    }
    for (const p of t.attrs['publisher'] ?? []) pubs.add(resolve(p, t.parent, m));
    for (const s of t.attrs['subscriber'] ?? []) subs.add(resolve(s, t.parent, m));
    const name = t.localId;
    const brokers = (t.attrs['via'] ?? []).map(v => resolve(v, t.parent, m));

    const liveBroker = brokers.find(b => expanded.has(b));
    if (liveBroker) {
      const b = liveBroker;
      for (const p of pubs) push(p, b, 'publishes', name, true);
      for (const s of subs) push(b, s, 'subscribes', name, true);
    } else {
      for (const p of pubs) for (const s of subs) push(p, s, 'publishes', name, true);
    }
    hidden.add(tid);
    // the declared publish/subscribe edges into the topic are replaced by the above
    for (let i = edges.length - 1; i >= 0; i--)
      if (edges[i]!.to === tid || edges[i]!.from === tid) edges.splice(i, 1);
  }

  {
    // A transit node is often also a declared endpoint: `sales calls gw`.
    // Collapsing it must therefore SPLICE it out — every in-edge is joined to
    // every out-edge — not merely delete it, or the actors lose their arrows.
    for (const id of transitIds) if (!expanded.has(id)) hidden.add(id);
    for (const h of hidden) {
      const ins = edges.filter(e => e.to === h && e.from !== h);
      const outs = edges.filter(e => e.from === h && e.to !== h);
      for (let i = edges.length - 1; i >= 0; i--)
        if (edges[i]!.from === h || edges[i]!.to === h) edges.splice(i, 1);
      const label = m.objects.get(h)?.localId;
      for (const a of ins) for (const b of outs)
        push(a.from, b.to, b.verb, a.label ?? b.label ?? (label ? `via ${label}` : undefined), true);
    }
  }

  // ---- build the node tree ----
  const build = (parent: string | undefined): RenderNode[] => {
    const out: RenderNode[] = [];
    for (const [id, o] of m.objects) {
      if (o.parent !== parent) continue;
      if (hidden.has(id) || NOT_DRAWN.has(o.kind) || offPhase.has(id)) continue;
      if (o.attrs['stage']?.[0] === 'retired') continue;    // kept in the model, off the picture (§17.4)
      if (PLACEMENT_KINDS.has(o.kind)) continue;          // where things run is the deployment picture
      if (foldInto(id) !== id) continue;                  // folded into a collapsed system
      const kids = collapsedSystems.has(id) ? [] : build(id);
      if (TRANSPARENT.has(o.kind)) { out.push(...kids); continue; }
      const folded = collapsedSystems.has(id) ? [...m.objects.keys()].filter(k => k.startsWith(id + '.') && !PLACEMENT_KINDS.has(m.objects.get(k)!.kind)).length : 0;
      out.push({
        id, kind: o.kind,
        label: o.name ?? o.localId,
        tech: o.attrs['tech']?.join(' '),
        meta: [metaLine(o.attrs), folded ? `${folded} inside` : ''].filter(Boolean).join(' · ') || undefined,
        phase: o.attrs['phase']?.[0],
        stage: o.attrs['stage']?.[0],
        folded: folded || undefined,
        transit: isTransit(o),
        ownedBy: o.attrs['owned_by']?.[0] ? resolve(o.attrs['owned_by'][0]!, o.parent, m) : undefined,
        external: o.kind === 'external' || o.kind === 'actor',
        children: BOUNDARY.has(o.kind) ? kids : kids.filter(k => k.kind === 'component'),
      });
    }
    return out;
  };

  const roots = build(undefined);
  const alive = new Set<string>();
  const mark = (ns: RenderNode[]) => ns.forEach(n => { alive.add(n.id); mark(n.children); });
  mark(roots);

  return { roots, edges: aggregate().filter(e => alive.has(e.from) && alive.has(e.to)) };
}


/**
 * The deployment picture (spec §16.1 `kind deployment`): environments hold
 * segments, clusters, managed services and nodes; each `run` puts a card for
 * the logical object inside its host. The object is referenced, not copied —
 * the same service running in two environments is two cards with one `ref`.
 * Relations between placed objects are drawn between their cards when both
 * sit in the same environment.
 */
function deploymentGraph(
  m: Model,
  rels: (ModelRelation & { fromId: string; toId: string })[],
  inPhase: (attrs: Record<string, string[]>) => boolean,
  phased: (id: string) => boolean,
  withAgents = true,
): RenderGraph {
  const cards = new Map<string, { id: string; ref: string; env: string }>();
  const envOf = (id: string): string => {
    let cur: string | undefined = id;
    while (cur) { const ob = m.objects.get(cur); if (!ob?.parent) return cur; cur = ob.parent; }
    return id;
  };

  const build = (parent: string | undefined): RenderNode[] => {
    const out: RenderNode[] = [];
    for (const [id, ob] of m.objects) {
      if (ob.parent !== parent || !PLACEMENT_KINDS.has(ob.kind) || phased(id)) continue;
      const kids = build(id);
      // objects that run here
      for (const p of m.placements) {
        if (p.host !== id || !inPhase(p.attrs)) continue;
        const refId = resolve(p.ref, undefined, m);
        const logical = m.objects.get(refId);
        if (!logical || phased(refId)) continue;
        const cid = `${id}/${refId}`;
        cards.set(cid, { id: cid, ref: refId, env: envOf(id) });
        kids.push({
          id: cid, kind: logical.kind, ref: refId,
          label: logical.name ?? logical.localId,
          tech: logical.attrs['tech']?.join(' '),
          meta: metaLine(effectiveSizing(m, p)),
          phase: p.attrs['phase']?.[0] ?? logical.attrs['phase']?.[0],
          transit: false, external: logical.kind === 'external', children: [],
        });
      }
      const load = hostLoad(m, id);
      const fmtG = (n: number) => (Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString());
      out.push({
        id, kind: ob.kind, label: ob.name ?? ob.localId,
        tech: ob.attrs['tech']?.join(' '), meta: metaLine(ob.attrs), phase: ob.attrs['phase']?.[0],
        load: load ? [load.cpu ? `cpu ${fmtG(load.cpu[0])}/${fmtG(load.cpu[1])}` : '', load.mem ? `mem ${fmtG(load.mem[0])}/${fmtG(load.mem[1])}Gi` : '']
          .filter(Boolean).join(' · ') + (load.over ? '  ⚠ over' : '') : undefined,
        over: load?.over,
        agents: withAgents && ob.attrs['agent']?.length ? ob.attrs['agent'] : undefined,
        transit: false, external: false, children: kids,
      });
    }
    return out;
  };

  const roots = build(undefined);
  const edges: RenderEdge[] = [];
  const byRef = new Map<string, { id: string; env: string }[]>();
  for (const c of cards.values()) (byRef.get(c.ref) ?? byRef.set(c.ref, []).get(c.ref)!).push(c);
  for (const r of rels) {
    for (const a of byRef.get(r.fromId) ?? []) for (const b of byRef.get(r.toId) ?? []) {
      if (a.env !== b.env || a.id === b.id) continue;
      const label = [r.label ?? r.over, r.port ? `:${r.port}` : undefined].filter(Boolean).join(' ') || undefined;
      if (edges.some(e => e.from === a.id && e.to === b.id && e.verb === r.verb)) continue;
      edges.push({ from: a.id, to: b.id, verb: r.verb, label, derived: true, dashed: false });
    }
  }
  return { roots, edges };
}
