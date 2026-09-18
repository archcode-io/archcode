/**
 * The compiled form (spec header: `arch.json`, schema `archcode/v1`) — the
 * model as plain data, and the same data written as YAML.
 *
 * This is a projection of the model, not a second syntax: comments, spacing
 * and the order of attributes on a line are gone, ids are full paths, every
 * attribute value is a list. It is what a tool that does not want to parse
 * ArchCode reads, and what the docs show under the YAML and JSON tabs.
 * Authoring in YAML or JSON (reading them back) is reserved (spec §15).
 */
import type { Model, ModelObject, ModelRelation, Placement, Interface } from './model.js';

export interface CompiledObject {
  id: string; kind: string; name?: string; parent?: string;
  attrs?: Record<string, string[]>;
  interfaces?: { verb: string; kind: string; pointer?: string; rev?: string; label?: string; attrs?: Record<string, string[]> }[];
  timeline?: { at: string; attrs: Record<string, string[]> }[];
}
export interface CompiledRelation {
  from: string; verb: string; to: string;
  over?: string; via?: string[]; spec?: string; as?: string; port?: string; label?: string;
  attrs?: Record<string, string[]>;
}
export interface CompiledPlacement { host: string; run: string; attrs?: Record<string, string[]>; timeline?: { at: string; attrs: Record<string, string[]> }[] }
export interface Compiled {
  archcode: string;
  objects: CompiledObject[];
  relations: CompiledRelation[];
  placements: CompiledPlacement[];
}

const nonEmpty = (o: Record<string, string[]>) => (Object.keys(o).length ? o : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function object(o: ModelObject): CompiledObject {
  return clean({
    id: o.id, kind: o.kind, name: o.name, parent: o.parent,
    attrs: nonEmpty(o.attrs),
    interfaces: o.interfaces.length ? o.interfaces.map((f: Interface) => clean({ verb: f.verb, kind: f.kind, pointer: f.pointer, rev: f.rev, label: f.label, attrs: nonEmpty(f.attrs) })) : undefined,
    timeline: o.timeline.length ? o.timeline.map(m => ({ at: m.when, attrs: m.attrs })) : undefined,
  });
}
function relation(r: ModelRelation): CompiledRelation {
  return clean({ from: r.from, verb: r.verb, to: r.to, over: r.over, via: r.via?.length ? r.via : undefined, spec: r.spec, as: r.as, port: r.port, label: r.label, attrs: nonEmpty(r.attrs) });
}
function placement(p: Placement): CompiledPlacement {
  return clean({ host: p.host, run: p.ref, attrs: nonEmpty(p.attrs), timeline: p.timeline.length ? p.timeline.map(m => ({ at: m.when, attrs: m.attrs })) : undefined });
}

/** The model as data. `version` is the language version the document declared, or the engine's. */
export function toCompiled(m: Model, version = '0.2'): Compiled {
  return {
    archcode: version,
    objects: [...m.objects.values()].map(object),
    relations: m.relations.map(relation),
    placements: m.placements.map(placement),
  };
}

export const toJSON = (m: Model, version?: string): string => JSON.stringify(toCompiled(m, version), null, 2) + '\n';

// ---- YAML: a small emitter for the shapes above (maps, lists, strings) ----
// Every value in the compiled form is a string. A YAML reader must get the same
// string back, so anything it would read as a number, a boolean or a tag is quoted;
// a token with a unit or a date (`8Gi`, `2027-01`, `0.7/2`) is a string either way.
const PLAIN = /^[A-Za-z0-9_][\w.\-\/+]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']);
const scalar = (v: string): string => (PLAIN.test(v) && !RESERVED.has(v.toLowerCase()) && !/^-?\d+(\.\d+)?$/.test(v) && !/^[\d.]+$/.test(v) ? v : JSON.stringify(v));
const flow = (list: string[]) => `[${list.map(scalar).join(', ')}]`;

function attrsYaml(attrs: Record<string, string[]>, indent: string): string[] {
  return Object.entries(attrs).map(([k, v]) => `${indent}${scalar(k)}: ${flow(v)}`);
}

export function toYAML(m: Model, version?: string): string {
  const c = toCompiled(m, version);
  const out: string[] = [`archcode: "${c.archcode}"`];
  const kv = (indent: string, k: string, v: string | undefined) => (v === undefined ? [] : [`${indent}${k}: ${scalar(v)}`]);
  out.push('objects:');
  for (const o of c.objects) {
    out.push(`  - id: ${scalar(o.id)}`, `    kind: ${o.kind}`, ...kv('    ', 'name', o.name), ...kv('    ', 'parent', o.parent));
    if (o.attrs) { out.push('    attrs:'); out.push(...attrsYaml(o.attrs, '      ')); }
    if (o.interfaces) {
      out.push('    interfaces:');
      for (const f of o.interfaces) {
        out.push(`      - verb: ${f.verb}`, `        kind: ${f.kind}`, ...kv('        ', 'pointer', f.pointer), ...kv('        ', 'rev', f.rev), ...kv('        ', 'label', f.label));
        if (f.attrs) { out.push('        attrs:'); out.push(...attrsYaml(f.attrs, '          ')); }
      }
    }
    if (o.timeline) {
      out.push('    timeline:');
      for (const t of o.timeline) { out.push(`      - at: ${scalar(t.at)}`, '        attrs:'); out.push(...attrsYaml(t.attrs, '          ')); }
    }
  }
  out.push(c.relations.length ? 'relations:' : 'relations: []');
  for (const r of c.relations) {
    out.push(`  - from: ${scalar(r.from)}`, `    verb: ${r.verb}`, `    to: ${scalar(r.to)}`,
      ...kv('    ', 'over', r.over), ...(r.via ? [`    via: ${flow(r.via)}`] : []), ...kv('    ', 'spec', r.spec), ...kv('    ', 'as', r.as), ...kv('    ', 'port', r.port), ...kv('    ', 'label', r.label));
    if (r.attrs) { out.push('    attrs:'); out.push(...attrsYaml(r.attrs, '      ')); }
  }
  out.push(c.placements.length ? 'placements:' : 'placements: []');
  for (const p of c.placements) {
    out.push(`  - host: ${scalar(p.host)}`, `    run: ${scalar(p.run)}`);
    if (p.attrs) { out.push('    attrs:'); out.push(...attrsYaml(p.attrs, '      ')); }
    if (p.timeline) {
      out.push('    timeline:');
      for (const t of p.timeline) { out.push(`      - at: ${scalar(t.at)}`, '        attrs:'); out.push(...attrsYaml(t.attrs, '          ')); }
    }
  }
  return out.join('\n') + '\n';
}
