import type { Attr, Decl, Doc, Iface, Node, Rel, Run } from './cst.js';
import { OPAQUE_KINDS } from './vocab.js';

/** The semantic model: a flat catalogue plus relations, lowered from the CST. */

/** Sizing at a later moment: `at 2026-12 cpu 12 mem 24Gi`. */
export interface Moment {
  when: string;                       // `2026-12`, `2027`, `+1y` — kept as written
  attrs: Record<string, string[]>;
}

/** `exposes http openapi://checkout.yaml @9f3c2e1` — a contract the object offers, by pointer (spec §4.3). */
export interface Interface {
  verb: 'exposes' | 'stores';
  kind: string;            // http · grpc · graphql · cli · schema …
  pointer?: string;        // `openapi://checkout.yaml`
  rev?: string;            // `9f3c2e1`
  label?: string;
  attrs: Record<string, string[]>;
  line: number;
}

export interface ModelObject {
  id: string;
  /** The identifier exactly as declared, without the scope prefix. */
  localId: string;
  kind: string;
  name?: string;
  attrs: Record<string, string[]>;
  /** Contracts this object exposes or stores, in document order. */
  interfaces: Interface[];
  /** Later moments of the same figures, in document order. */
  timeline: Moment[];
  parent?: string;
  line: number;
}

export interface ModelRelation {
  from: string;
  to: string;
  verb: string;            // canonical
  over?: string;
  via?: string[];
  spec?: string;
  as?: string;
  port?: string;
  label?: string;
  /** Attributes from the relation body: `{ phase transit  timeout 2s }`. */
  attrs: Record<string, string[]>;
  line: number;
}

/**
 * `run checkout replicas 6 cpu 2 mem 4Gi` inside a placement block: the logical
 * object `checkout` runs on `host`. One object may run in many places; the
 * object is never copied (spec §6).
 */
export interface Placement {
  host: string;            // id of the env / cluster / managed / segment / node
  ref: string;             // as written; resolved against the model at render
  attrs: Record<string, string[]>;
  timeline: Moment[];
  line: number;
}

export interface Model {
  objects: Map<string, ModelObject>;
  relations: ModelRelation[];
  placements: Placement[];
}

/** Repeated keys accumulate: two `subscriber` lines mean two subscribers. */
const mergeAttrs = (into: Record<string, string[]>, list: Attr[]): Record<string, string[]> => {
  // own keys only: an attribute called `constructor` must not meet Object.prototype
  for (const a of list) into[a.key] = [...(Object.prototype.hasOwnProperty.call(into, a.key) ? into[a.key]! : []), ...a.values];
  return into;
};
const attrsOf = (list: Attr[]): Record<string, string[]> => mergeAttrs({}, list);

const isMoment = (v: string) => /^(\d{4}(-\d{2}){0,2}|\+\d+[dwmy])$/.test(v);

/** `at 2026-12 cpu 12 mem 24Gi` → { when: '2026-12', attrs: { cpu: ['12'], mem: ['24Gi'] } } */
function momentOf(values: string[]): Moment | undefined {
  const [when, ...rest] = values;
  if (!when || !isMoment(when)) return undefined;
  // `count 3 cpu 16 disk data 15Ti` — a sizing key starts a pair, everything
  // up to the next sizing key is its value (`disk data 15Ti`, `capacity size 7Ti`)
  const KEYS = new Set(['replicas', 'count', 'nodes', 'cpu', 'mem', 'disk', 'gpu', 'capacity']);
  const attrs: Record<string, string[]> = {};
  let k: string | undefined;
  for (const w of rest) {
    if (KEYS.has(w) || k === undefined) { k = w; if (!Object.prototype.hasOwnProperty.call(attrs, k)) attrs[k] = []; continue; }
    attrs[k]!.push(w);
  }
  return { when, attrs };
}

/** Body lines split into plain attributes and `at` moments. */
function bodyAttrs(body: Node[] | undefined, into: Record<string, string[]>): Moment[] {
  const timeline: Moment[] = [];
  for (const c of body ?? []) {
    if (c.type !== 'attr') continue;
    const a = c as Attr;
    const m = a.key === 'at' ? momentOf(a.values) : undefined;
    if (m) timeline.push(m); else mergeAttrs(into, [a]);
  }
  return timeline;
}

export function lower(doc: Doc): Model {
  const objects = new Map<string, ModelObject>();
  const relations: ModelRelation[] = [];
  const placements: Placement[] = [];
  // an interface with an explicit subject may name an object declared later
  const pendingIfaces: { owner: string; scope?: string; iface: Interface }[] = [];

  const walk = (nodes: Node[], parent?: string) => {
    for (const n of nodes) {
      if (n.type === 'decl') {
        const d = n as Decl;
        // a declaration without an id was reported by the parser (AC002); the
        // statement stays in the tree, but there is no object to build from it
        if (!d.id) { if (d.body) walk(d.body, parent); continue; }
        const id = parent && !d.id.includes('.') ? `${parent}.${d.id}` : d.id;
        const attrs = attrsOf(d.inline);
        const timeline = bodyAttrs(d.body, attrs);
        objects.set(id, {
          id, localId: d.id, kind: d.kind, name: d.name, attrs, timeline, parent, interfaces: [],
          line: d.tokens[0]?.line ?? 0,
        });
        if (d.body && !OPAQUE_KINDS.has(d.kind)) walk(d.body, id);   // a view or a reserved block holds no objects
      } else if (n.type === 'iface') {
        const f = n as Iface;
        const attrs: Record<string, string[]> = {};
        bodyAttrs(f.body, attrs);
        pendingIfaces.push({ owner: f.subject ?? parent ?? '', scope: parent, iface: {
          verb: f.verb, kind: f.kind, pointer: f.pointer, rev: f.rev, label: f.label, attrs, line: f.tokens[0]?.line ?? 0,
        } });
      } else if (n.type === 'rel') {
        const r = n as Rel;
        const from = r.subject ?? parent ?? '';
        const attrs: Record<string, string[]> = {};
        bodyAttrs(r.body, attrs);
        relations.push({
          from, to: r.object, verb: r.canonicalVerb,
          over: r.over, via: r.via, spec: r.spec, as: r.as, port: r.port, label: r.label, attrs,
          line: r.tokens[0]?.line ?? 0,
        });
        if (r.body) walk(r.body, parent);
      } else if (n.type === 'run') {
        const r = n as Run;
        // an `at …` written inline (`run x replicas 2  at 2027-01 replicas 4`) is a moment like one in the body
        const attrs = attrsOf(r.attrs.filter(a => !(a.key === 'at' && momentOf(a.values))));
        const timeline = [...r.attrs.filter(a => a.key === 'at').map(a => momentOf(a.values)).filter((m): m is Moment => !!m), ...bodyAttrs(r.body, attrs)];
        // `run` outside a host is reported (AC108); it places nothing
        if (parent) for (const ref of r.refs)
          placements.push({ host: parent, ref, attrs, timeline, line: r.tokens[0]?.line ?? 0 });
      }
    }
  };

  walk(doc.body);
  for (const { owner, scope, iface } of pendingIfaces) {
    const target = objects.get(owner) ?? (scope ? objects.get(`${scope}.${owner}`) : undefined)
      ?? [...objects.values()].find(o => o.localId === owner);
    target?.interfaces.push(iface);
  }
  return { objects, relations, placements };
}
