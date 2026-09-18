import type { Attr, Decl, Doc, Iface, Node, Rel, Run } from './cst.js';
import { diag, type Diagnostic } from './diagnostics.js';
import type { Model } from './model.js';
import { ATTR_KEYS, IFACE_VERBS, OBJECT_KINDS, PLACEMENT_KINDS, RESERVED_KINDS, RUN_KEYS, VERBS } from './vocab.js';

/**
 * Semantic diagnostics (spec §17.10). The parser only knows shapes; this pass
 * knows names. It never changes the document and never stops a render — the
 * lens still draws what it can — it only says what a reader would trip on.
 *
 *   AC100  duplicate id                      error
 *   AC101  unresolved reference              warning
 *   AC102  ambiguous reference               warning
 *   AC103  reserved block kind               info      (rule · decision · board · profile — kept, not interpreted)
 *   AC104  unknown attribute                 info      (`x-…` keys are silent: they are yours)
 *   AC105  `archcode <version>` pragma       warning   (unknown version, or not the first statement)
 *   AC106  `at` without a moment             error
 *   AC107  relation between placement blocks warning   (a node does not `call` a cluster — put things inside)
 *   AC108  `run` outside a placement block   error
 *   AC109  `run` of something that cannot run warning  (an actor, an external, a topic)
 */

export const LANGUAGE_VERSIONS = new Set(['0.1', '0.2']);

const RUNNABLE = new Set(['service', 'webapp', 'app', 'gateway', 'broker', 'datastore', 'cache', 'function', 'job', 'component']);
const isMoment = (v: string) => /^(\d{4}(-\d{2}){0,2}|\+\d+[dwmy])$/.test(v);

/** Every full id a reference could mean, from where it is written. */
function candidates(ref: string, scope: string | undefined, m: Model): string[] {
  if (m.objects.has(ref)) return [ref];
  let s = scope;
  while (s) {
    const cand = `${s}.${ref}`;
    if (m.objects.has(cand)) return [cand];
    const dot = s.lastIndexOf('.');
    s = dot < 0 ? undefined : s.slice(0, dot);
  }
  return [...m.objects.keys()].filter(k => k.endsWith(`.${ref}`));
}

export function check(doc: Doc, m: Model): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Strictness follows the stage (§17.4): a sketch or a retired thing is not
  // scolded at all, a proposal only warned. The stage a line sits under is the
  // stage of the innermost declaration that carries one.
  const stageOfLine = new Map<number, string>();
  const stageWalk = (nodes: Node[], inherited: string | undefined) => {
    for (const n of nodes) {
      if (n.type !== 'decl') continue;
      const d = n as Decl;
      const own = d.inline.find(a => a.key === 'stage')?.values[0]
        ?? (d.body ?? []).filter(c => c.type === 'attr').map(c => c as Attr).find(a => a.key === 'stage')?.values[0];
      const stage = own ?? inherited;
      const first = d.tokens[0]?.line ?? 0, last = d.tokens[d.tokens.length - 1]?.line ?? first;
      if (stage) for (let l = first; l <= last; l++) stageOfLine.set(l, stage);
      stageWalk(d.body ?? [], stage);
    }
  };
  stageWalk(doc.body, undefined);
  const line = (n: Node) => n.tokens[0]?.line ?? 0;
  const col = (n: Node) => n.tokens[0]?.col ?? 1;

  // Reference lookups only ever see model objects, so a name that resolves
  // is fine wherever it was written; a name that does not is reported once.
  const refCheck = (ref: string, scope: string | undefined, what: string, n: Node) => {
    if (!ref || /^\d/.test(ref)) return;
    const c = candidates(ref, scope, m);
    if (c.length === 0) out.push(diag('warning', 'AC101', `${what} \`${ref}\` is not declared anywhere`, line(n), col(n)));
    else if (c.length > 1) out.push(diag('warning', 'AC102', `${what} \`${ref}\` could be ${c.join(' or ')} — write the full path`, line(n), col(n)));
  };

  // ---- pragma: first statement or nowhere ----
  let first = true;
  const seen = new Map<string, number>();

  const walk = (nodes: Node[], parent: string | undefined, parentKind: string | undefined, depth: number) => {
    for (const n of nodes) {
      if (n.type === 'blank') continue;
      if (n.type === 'attr' && (n as Attr).key === 'archcode' && depth === 0) {
        const v = (n as Attr).values[0] ?? '';
        if (!first) out.push(diag('warning', 'AC105', '`archcode <version>` belongs at the top of the document', line(n), col(n)));
        else if (!LANGUAGE_VERSIONS.has(v)) out.push(diag('warning', 'AC105', `archcode ${v || '?'} — this engine reads ${[...LANGUAGE_VERSIONS].join(', ')}`, line(n), col(n)));
        first = false; continue;
      }
      first = false;

      if (n.type === 'decl') {
        const d = n as Decl;
        const id = parent && !d.id.includes('.') ? `${parent}.${d.id}` : d.id;
        if (seen.has(id)) out.push(diag('error', 'AC100', `\`${id}\` is declared twice (first at line ${seen.get(id)})`, line(n), col(n)));
        else seen.set(id, line(n));
        if (RESERVED_KINDS.has(d.kind)) {
          out.push(diag('info', 'AC103', `\`${d.kind}\` is reserved in v0.2 — kept as written, not interpreted`, line(n), col(n)));
          continue;                                            // its body is not the model's business
        }
        if (d.kind === 'view') continue;                      // the view vocabulary is checked by the picture, not here
        for (const a of d.inline) attrCheck(a, parent, d.kind);
        for (const c of d.body ?? []) if (c.type === 'attr') attrCheck(c as Attr, parent, d.kind);
        walk(d.body ?? [], id, d.kind, depth + 1);
        continue;
      }
      if (n.type === 'rel') {
        const r = n as Rel;
        const from = r.subject ?? parent ?? '';
        if (r.subject) refCheck(r.subject, parent, 'subject', n);
        else if (!parent) out.push(diag('warning', 'AC101', `\`${r.verb}\` at top level needs a subject: \`checkout ${r.verb} ${r.object}\``, line(n), col(n)));
        refCheck(r.object, parent, `${r.verb} target`, n);
        for (const v of r.via ?? []) refCheck(v, parent, 'via', n);
        const kindOf = (ref: string) => { const c = candidates(ref, parent, m); return c.length === 1 ? m.objects.get(c[0]!)?.kind : undefined; };
        const fk = kindOf(from), tk = kindOf(r.object);
        if (fk && tk && PLACEMENT_KINDS.has(fk) && PLACEMENT_KINDS.has(tk))
          out.push(diag('warning', 'AC107', `a ${fk} does not \`${r.verb}\` a ${tk} — nest it (\`${tk} … { ${fk} … }\`) or \`run\` something on it`, line(n), col(n)));
        for (const c of r.body ?? []) if (c.type === 'attr') attrCheck(c as Attr, parent, 'relation');
        continue;
      }
      if (n.type === 'run') {
        const r = n as Run;
        if (!parentKind || !PLACEMENT_KINDS.has(parentKind))
          out.push(diag('error', 'AC108', '`run` only makes sense inside an env, segment, cluster, managed service or node', line(n), col(n)));
        for (const ref of r.refs) {
          refCheck(ref, parent, 'run target', n);
          const c = candidates(ref, parent, m);
          const k = c.length === 1 ? m.objects.get(c[0]!)?.kind : undefined;
          if (k && !RUNNABLE.has(k)) out.push(diag('warning', 'AC109', `\`${ref}\` is a ${k} — it has nowhere to run`, line(n), col(n)));
        }
        for (const a of r.attrs) if (!RUN_KEYS.has(a.key) && !a.key.startsWith('x-'))
          out.push(diag('info', 'AC104', `\`${a.key}\` is not a sizing key (${[...RUN_KEYS].join(', ')})`, line(n), col(n)));
        for (const c of r.body ?? []) if (c.type === 'attr') attrCheck(c as Attr, parent, 'run');
        continue;
      }
      if (n.type === 'iface') {
        const f = n as Iface;
        if (f.subject) refCheck(f.subject, parent, 'subject', n);
        else if (!parent) out.push(diag('warning', 'AC101', `\`${f.verb}\` at top level needs a subject: \`checkout ${f.verb} ${f.kind} …\``, line(n), col(n)));
        continue;
      }
      if (n.type === 'attr' && depth === 0) {
        const a = n as Attr;
        // a lone verb line at the top means someone forgot the subject
        if (VERBS.has(a.key) || IFACE_VERBS.has(a.key)) out.push(diag('warning', 'AC101', `\`${a.key}\` needs a subject at top level`, line(n), col(n)));
        else if (!ATTR_KEYS.has(a.key) && !a.key.startsWith('x-') && !OBJECT_KINDS.has(a.key))
          out.push(diag('info', 'AC104', `\`${a.key}\` is not something the document knows — an object kind or an attribute?`, line(n), col(n)));
      }
    }
  };

  const attrCheck = (a: Attr, scope: string | undefined, ownerKind: string) => {
    if (a.key === 'at') {
      if (!a.values[0] || !isMoment(a.values[0]))
        out.push(diag('error', 'AC106', '`at` needs a moment first: `at 2026-12 cpu 12`, `at +1y replicas 8`', line(a), col(a)));
      return;
    }
    if (a.key === 'owned_by') { refCheck(a.values[0] ?? '', scope, 'owned_by', a); return; }
    if (a.key === 'publisher' || a.key === 'subscriber' || a.key === 'via') { for (const v of a.values) refCheck(v, scope, a.key, a); return; }
    if (!ATTR_KEYS.has(a.key) && !a.key.startsWith('x-') && !VERBS.has(a.key))
      out.push(diag('info', 'AC104', `\`${a.key}\` is not a known attribute of a ${ownerKind} — kept as written (prefix \`x-\` to say it is yours)`, line(a), col(a)));
  };

  walk(doc.body, undefined, undefined, 0);
  return out.filter(d => {
    const st = stageOfLine.get(d.line);
    if (st === 'sketch' || st === 'retired') return false;
    if (st === 'proposed' && d.severity === 'error') d.severity = 'warning';
    return true;
  }).sort((a, b) => a.line - b.line || a.col - b.col);
}
