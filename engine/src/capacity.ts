import type { Model, Moment, Placement } from './model.js';
import { PLACEMENT_KINDS } from './vocab.js';

/**
 * The resources table — the slide every architecture committee asks for
 * (a sizing sheet with a total per environment). It is a projection of the placement blocks,
 * never a thing written by hand: every `node`, sized `cluster` and sized `run`
 * contributes its figures times its multiplier, per environment, per moment.
 */

export interface Figures { cpu?: number; mem?: number; disk?: number; gpu?: number }
export const FIGURE_KEYS: (keyof Figures)[] = ['cpu', 'mem', 'disk', 'gpu'];

export interface CapacityRow {
  id: string;             // object id, or `host/ref` for a run
  /** For a node/cluster: what runs on it asks for, and whether that exceeds it. */
  load?: HostLoad;
  label: string;
  kind: string;           // node · cluster · run · data (what a store holds, from `capacity size/growth`)
  host?: string;          // for a run: where it runs
  /**
   * Pods inside a sized cluster are demand on capacity the cluster row already
   * counts, so they are listed but not summed. A run inside an unsized cluster
   * or a managed service is the only figure there is, and it counts.
   */
  counted: boolean;
  figures: Record<string, Figures & { count: number }>;   // per moment
}

export interface CapacityEnv {
  id: string; label: string;
  rows: CapacityRow[];
  totals: Record<string, Figures>;
}

export interface CapacityTable { moments: string[]; envs: CapacityEnv[] }

/** `4Gi` `800Mi` `2Ti` `16GB` `300` → GiB */
export function toGiB(v: string | undefined): number | undefined {
  if (!v) return undefined;
  v = v.split('/').pop()!;                 // `800Mi/2Gi` (requests/limit) → the limit
  const m = v.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  const u = m[2]!.toLowerCase();
  if (u === 'mi' || u === 'mb' || u === 'm') return n / 1024;
  if (u === 'ti' || u === 'tb' || u === 't') return n * 1024;
  if (u === 'ki' || u === 'kb' || u === 'k') return n / 1024 / 1024;
  return n;   // Gi, GB, G, bare
}

/** `0.7/2` (requests/limit) → the limit; `2` → 2 */
export function toCpu(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const last = v.split('/').pop()!;
  const n = parseFloat(last);
  return Number.isFinite(n) ? n : undefined;
}

const num = (v: string | undefined) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : undefined; };

export const SIZING_KEYS = ['replicas', 'count', 'nodes', 'cpu', 'mem', 'disk', 'gpu'];

/**
 * A placement's sizing, with the logical object's own figures as defaults:
 * `service api cpu 2` placed with a bare `run api` still runs at 2 cpu, and
 * `run api cpu 4` overrides it there.
 */
export function effectiveSizing(m: Model, p: Placement): Record<string, string[]> {
  const logical = [...m.objects.values()].find(o => o.id === p.ref || o.localId === p.ref);
  const out: Record<string, string[]> = {};
  for (const k of SIZING_KEYS) if (logical?.attrs[k]) out[k] = logical.attrs[k]!;
  return { ...out, ...p.attrs };
}

/**
 * What the things running on a host ask for, against what the host offers.
 * cpu/mem of every `run` × replicas, against the host's figures × count.
 */
export interface HostLoad { cpu?: [number, number]; mem?: [number, number]; over: boolean }
export function hostLoad(m: Model, hostId: string): HostLoad | undefined {
  const host = m.objects.get(hostId);
  if (!host || (host.kind !== 'node' && host.kind !== 'cluster')) return undefined;
  const cap = figuresOf(host.attrs);
  const mult = num(host.attrs['count']?.[0]) ?? num(host.attrs['nodes']?.[0]) ?? 1;
  const runs = m.placements.filter(p => p.host === hostId);
  if (!runs.length || (cap.cpu === undefined && cap.mem === undefined)) return undefined;
  const demand: Figures = {};
  for (const p of runs) {
    const a = effectiveSizing(m, p);
    const f = figuresOf(a);
    const n = num(a['replicas']?.[0]) ?? 1;
    if (f.cpu !== undefined) demand.cpu = (demand.cpu ?? 0) + f.cpu * n;
    if (f.mem !== undefined) demand.mem = (demand.mem ?? 0) + f.mem * n;
  }
  const out: HostLoad = { over: false };
  if (cap.cpu !== undefined && demand.cpu !== undefined) { out.cpu = [demand.cpu, cap.cpu * mult]; if (demand.cpu > cap.cpu * mult) out.over = true; }
  if (cap.mem !== undefined && demand.mem !== undefined) { out.mem = [demand.mem, cap.mem * mult]; if (demand.mem > cap.mem * mult) out.over = true; }
  if (!out.cpu && !out.mem) return undefined;
  return out;
}

function figuresOf(attrs: Record<string, string[]>): Figures {
  const f: Figures = {};
  const cpu = toCpu(attrs['cpu']?.[0]); if (cpu !== undefined) f.cpu = cpu;
  const mem = toGiB(attrs['mem']?.[0]); if (mem !== undefined) f.mem = mem;
  const disk = attrs['disk'];
  if (disk?.length) {
    // `disk 300Gi` or `disk system 30Gi data 200Gi` — sum every figure present
    const parts = disk.map(toGiB).filter((x): x is number => x !== undefined);
    if (parts.length) f.disk = parts.reduce((a, b) => a + b, 0);
  }
  const gpu = attrs['gpu'];
  if (gpu?.length) f.gpu = num(gpu[0]) ?? 1;
  return f;
}

/** Moments sort as written dates; relative ones (`+1y`) come after, by size. */
const momentKey = (w: string) => (w.startsWith('+') ? `~${w.slice(1).padStart(6, '0')}` : w);

/** Attributes as they stand at `when`: base, overlaid by every earlier moment. */
function attrsAt(base: Record<string, string[]>, timeline: Moment[], when: string): Record<string, string[]> {
  if (when === 'now') return base;
  const out = { ...base };
  for (const t of timeline) if (momentKey(t.when) <= momentKey(when)) Object.assign(out, t.attrs);
  return out;
}

const scale = (f: Figures, n: number): Figures => {
  const out: Figures = {};
  for (const k of FIGURE_KEYS) if (f[k] !== undefined) out[k] = f[k]! * n;
  return out;
};
const add = (a: Figures, b: Figures): Figures => {
  const out: Figures = { ...a };
  for (const k of FIGURE_KEYS) if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!;
  return out;
};

export function capacityTable(m: Model, opt: { phase?: string } = {}): CapacityTable {
  const inPhase = (attrs: Record<string, string[]>) =>
    !opt.phase || !attrs['phase']?.length || attrs['phase'].includes(opt.phase);
  const envOf = (id: string): string => {
    let cur: string | undefined = id;
    while (cur) { const ob = m.objects.get(cur); if (!ob?.parent) return cur; cur = ob.parent; }
    return id;
  };
  const hostKind = (id: string) => m.objects.get(id)?.kind;

  // every moment anyone mentions
  const moments = new Set<string>();
  for (const ob of m.objects.values()) for (const t of ob.timeline) moments.add(t.when);
  for (const p of m.placements) for (const t of p.timeline) moments.add(t.when);
  const cols = ['now', ...[...moments].sort((a, b) => momentKey(a).localeCompare(momentKey(b)))];

  const envs = new Map<string, CapacityEnv>();
  const envFor = (id: string): CapacityEnv => {
    const e = envOf(id);
    if (!envs.has(e)) {
      const ob = m.objects.get(e);
      envs.set(e, { id: e, label: ob?.name ?? ob?.localId ?? e, rows: [], totals: {} });
    }
    return envs.get(e)!;
  };

  const rowOf = (id: string, label: string, kind: string, base: Record<string, string[]>,
                 timeline: Moment[], countKey: string[], host?: string): CapacityRow => {
    const figures: CapacityRow['figures'] = {};
    for (const when of cols) {
      const a = attrsAt(base, timeline, when);
      const count = countKey.map(k => num(a[k]?.[0])).find(x => x !== undefined) ?? 1;
      figures[when] = { ...scale(figuresOf(a), count), count };
    }
    return { id, label, kind, host, figures, counted: true };
  };

  // nodes and sized clusters are resources in themselves
  for (const [id, ob] of m.objects) {
    if (!PLACEMENT_KINDS.has(ob.kind) || !inPhase(ob.attrs)) continue;
    if (ob.kind === 'node')
      envFor(id).rows.push({ ...rowOf(id, ob.name ?? ob.localId, 'node', ob.attrs, ob.timeline, ['count']), load: hostLoad(m, id) });
    else if (ob.kind === 'cluster' && (ob.attrs['cpu'] || ob.attrs['mem']))
      envFor(id).rows.push({ ...rowOf(id, ob.name ?? ob.localId, 'cluster', ob.attrs, ob.timeline, ['nodes', 'count']), load: hostLoad(m, id) });
  }
  // a sized run inside a cluster or a managed service is a resource too;
  // a run on a node is not — the node already is
  for (const p of m.placements) {
    if (!inPhase(p.attrs) || hostKind(p.host) === 'node' || hostKind(p.host) === undefined) continue;
    const a = effectiveSizing(m, p);
    if (!a['cpu'] && !a['mem'] && !a['disk'] && !a['gpu']) continue;
    const logical = [...m.objects.values()].find(o => o.id === p.ref || o.localId === p.ref);
    const host = m.objects.get(p.host)!;
    const row = rowOf(`${p.host}/${p.ref}`, logical?.name ?? p.ref, 'run', a, p.timeline, ['replicas'], p.host);
    row.counted = host.kind !== 'cluster' || (!host.attrs['cpu'] && !host.attrs['mem']);
    envFor(p.host).rows.push(row);
  }

  // what the stores hold: `capacity size 340Gi growth 11Gi/mo` on a datastore or cache,
  // shown in the environment it runs in — a line of its own, not summed into the
  // disk of the hosts (that is sizing; this is content, and it grows)
  const monthsFrom = (when: string): number | undefined => {
    if (when === 'now') return 0;
    const rel = /^\+(\d+)([dwmy])$/.exec(when);
    if (rel) return +rel[1]! * ({ d: 1 / 30, w: 7 / 30, m: 1, y: 12 } as Record<string, number>)[rel[2]!]!;
    const abs = /^(\d{4})(?:-(\d{2}))?/.exec(when);
    if (!abs) return undefined;
    const now = new Date();
    return (+abs[1]! - now.getUTCFullYear()) * 12 + ((abs[2] ? +abs[2] : 1) - (now.getUTCMonth() + 1));
  };
  for (const p of m.placements) {
    const logical = [...m.objects.values()].find(o => o.id === p.ref || o.localId === p.ref);
    if (!logical || (logical.kind !== 'datastore' && logical.kind !== 'cache') || !inPhase(logical.attrs)) continue;
    const cap = logical.attrs['capacity'] ?? [];
    const pair = (k: string) => { const i = cap.indexOf(k); return i >= 0 ? cap[i + 1] : undefined; };
    const size = toGiB(pair('size'));
    if (size === undefined) continue;
    const g = /^(\d+(?:\.\d+)?\s*[A-Za-z]*)\/(d|w|mo|m|y)$/.exec(pair('growth') ?? '');
    const perMonth = g ? (toGiB(g[1]) ?? 0) * ({ d: 30, w: 30 / 7, mo: 1, m: 1, y: 1 / 12 } as Record<string, number>)[g[2]!]! : 0;
    const figures: CapacityRow['figures'] = {};
    for (const when of cols) {
      const months = monthsFrom(when);
      figures[when] = { disk: Math.round((size + perMonth * Math.max(0, months ?? 0)) * 10) / 10, count: 1 };
    }
    if (m.objects.get(p.host)) envFor(p.host).rows.push({ id: `${p.host}/${p.ref}#data`, label: `${logical.name ?? p.ref} · data`, kind: 'data', host: p.host, figures, counted: false });
  }

  for (const e of envs.values())
    for (const when of cols)
      e.totals[when] = e.rows.filter(r => r.counted).reduce((acc, r) => add(acc, r.figures[when]!), {} as Figures);

  return { moments: cols, envs: [...envs.values()] };
}

/** `12.5` → `12.5`, `0.78125` → `0.8`, `2048` → `2048` */
export const fmt = (n: number | undefined): string =>
  n === undefined ? '' : Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
