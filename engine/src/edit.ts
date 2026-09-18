import { parse } from './parser.js';
import type { Attr, Decl, Doc, Iface, Node, Rel, Run } from './cst.js';
import { tokenText, type Token } from './tokens.js';

/**
 * Surgical edits to the source text.
 *
 * The canvas has to be able to create, rename and delete things, and the file
 * has to agree — but a canvas action must not reformat a document a person
 * wrote by hand. So every edit here touches only the lines it must, guided by
 * the parse tree, and leaves the rest of the file byte for byte alone.
 */

interface Span { start: number; end: number }         // 1-based, inclusive

const span = (tokens: Token[]): Span => ({
  start: tokens[0]?.line ?? 1,
  end: tokens[tokens.length - 1]?.line ?? tokens[0]?.line ?? 1,
});

function each(nodes: Node[], fn: (n: Node) => void) {
  for (const n of nodes) {
    fn(n);
    const body = (n as Decl | Rel).body;
    if (body) each(body, fn);
  }
}

const findDecl = (doc: Doc, id: string): Decl | undefined => {
  let hit: Decl | undefined;
  each(doc.body, n => { if (!hit && n.type === 'decl' && (n as Decl).id === id) hit = n as Decl; });
  return hit;
};

/** Where a new top-level statement should go: after the model, before the view. */
function insertPoint(src: string): number {
  const lines = src.split('\n');
  const viewAt = lines.findIndex(l => /^\s*(view|board)\b/.test(l));
  if (viewAt < 0) return lines.length;
  let i = viewAt;
  while (i > 0 && lines[i - 1]!.trim() === '') i--;
  return i;
}

const splice = (src: string, at: number, remove: number, insert: string[]): string => {
  const lines = src.split('\n');
  lines.splice(at, remove, ...insert);
  return lines.join('\n');
};

// ── objects ───────────────────────────────────────────────────────────────
/**
 * Append one statement written in the notation itself — a declaration or a
 * relation typed into the canvas terminal. The line goes in verbatim, before
 * the first `view`/`board` block, so what the person typed is what the file
 * says; nothing is normalised on the way in.
 */
export function insertStatement(src: string, line: string): string {
  const at = insertPoint(src);
  const before = src.split('\n')[at - 1];
  return splice(src, at, 0, [...(before && before.trim() ? [''] : []), line.trim()]);
}

export function addObject(
  src: string,
  o: { kind: string; id: string; name?: string; attrs?: Record<string, string> },
): string {
  const parts = [o.kind, o.id];
  if (o.name) parts.push(JSON.stringify(o.name));
  for (const [k, v] of Object.entries(o.attrs ?? {})) parts.push(k, /\s/.test(v) ? JSON.stringify(v) : v);
  const at = insertPoint(src);
  const before = src.split('\n')[at - 1];
  return splice(src, at, 0, [...(before && before.trim() ? [''] : []), parts.join(' ')]);
}

export function deleteObject(src: string, id: string): string {
  const { doc } = parse(src);
  const d = findDecl(doc, id);
  let out = src;
  if (d) {
    const s = span(d.tokens);
    out = splice(out, s.start - 1, s.end - s.start + 1, []);
  }
  // and every relation that mentions it — a dangling arrow is worse than none
  for (;;) {
    const { doc: d2 } = parse(out);
    let hit: Rel | Iface | undefined;
    each(d2.body, n => {
      if (hit) return;
      if (n.type === 'iface') { if ((n as Iface).subject === id) hit = n as Iface; return; }
      if (n.type !== 'rel') return;
      const r = n as Rel;
      if (r.subject === id || r.object === id || (r.via ?? []).includes(id)) hit = r;
    });
    if (!hit) break;
    const s = span(hit.tokens);
    out = splice(out, s.start - 1, s.end - s.start + 1, []);
  }
  return out;
}

/** Rename everywhere: the declaration and every reference to it. */
export function renameObject(src: string, oldId: string, newId: string): string {
  const re = new RegExp(`(^|[^\\w.-])${oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
  return src.split('\n').map(line => {
    const ci = line.indexOf('#');
    const [code, cm] = ci >= 0 ? [line.slice(0, ci), line.slice(ci)] : [line, ''];
    return code.replace(re, (_, p) => p + newId) + cm;
  }).join('\n');
}

export function setDisplayName(src: string, id: string, name: string): string {
  const { doc } = parse(src);
  const d = findDecl(doc, id);
  if (!d) return src;
  const lines = src.split('\n');
  const quoted = JSON.stringify(name);

  // The identifier's position comes from its token, never from searching the
  // line: `datastore db` is fine, but `datastore datastore` would find the
  // KIND first and insert the name in front of the identifier.
  const idTok = d.tokens.find(t => t.kind === 'word' && t.text === id && t !== d.tokens[0]);
  const nameTok = d.tokens.find(t => t.kind === 'string');
  const line = (nameTok ?? idTok ?? d.tokens[0]!).line;
  const cur = lines[line - 1]!;

  if (nameTok) {
    const from = nameTok.col - 1;
    return splice(src, line - 1, 1, [cur.slice(0, from) + quoted + cur.slice(from + nameTok.text.length)]);
  }
  if (!name) return src;
  const at = idTok ? idTok.col - 1 + idTok.text.length : cur.length;
  return splice(src, line - 1, 1, [cur.slice(0, at) + ' ' + quoted + cur.slice(at)]);
}

export function setAttribute(src: string, id: string, key: string, value: string | null): string {
  const { doc } = parse(src);
  const d = findDecl(doc, id);
  if (!d) return src;
  const lines = src.split('\n');
  const declLine = span(d.tokens).start;
  // A list (`antivirus, alloy`) stays a list; anything else with a space is one quoted string.
  const isList = /^[^"\s,]+(\s*,\s*[^"\s,]+)+$/.test(value ?? '');
  const token = isList ? value!.split(/\s*,\s*/).join(', ') : /\s/.test(value ?? '') ? JSON.stringify(value) : value;
  const VAL = '("[^"]*"|[^\\s,]+(?:\\s*,\\s*[^\\s,]+)*)';   // a quoted string, a word, or a comma list

  const inline = d.inline.find(a => a.key === key);
  const inBody = (d.body ?? []).find(n => n.type === 'attr' && (n as Attr).key === key) as Attr | undefined;
  const target = inline ?? inBody;

  if (target) {
    const at = span(target.tokens).start;
    const cur = lines[at - 1]!;
    if (value === null) {
      const stripped = cur.replace(new RegExp(`\\s*\\b${key}\\b\\s+${VAL}`), '');
      return splice(src, at - 1, 1, stripped.trim() ? [stripped] : []);
    }
    return splice(src, at - 1, 1,
      [cur.replace(new RegExp(`(\\b${key}\\b\\s+)${VAL}`), `$1${token}`)]);
  }
  if (value === null) return src;
  if (d.body) {
    const ds = span(d.tokens);
    if (ds.end === ds.start)          // one-line body: `{ transit }` → `{ transit  key value }`
      return splice(src, declLine - 1, 1, [lines[declLine - 1]!.replace(/\s*\}\s*$/, `  ${key} ${token} }`)]);
    const indent = lines[declLine - 1]!.match(/^[ \t]*/)![0] + '  ';
    return splice(src, declLine, 0, [indent + key + ' ' + token]);
  }
  return splice(src, declLine - 1, 1, [lines[declLine - 1]!.replace(/\s*$/, '') + `  ${key} ${token}`]);
}

// ── relations ─────────────────────────────────────────────────────────────
export function addRelation(
  src: string, from: string, verb: string, to: string, over?: string,
): string {
  const line = [from, verb, to, ...(over ? ['over', /\s/.test(over) ? JSON.stringify(over) : over] : [])].join(' ');
  const at = insertPoint(src);
  const before = src.split('\n')[at - 1];
  return splice(src, at, 0, [...(before && before.trim() ? [''] : []), line]);
}

/**
 * Move one end of a relation to another object — the text edit behind
 * dropping an arrow's end on a different card. Only the token that names the
 * end changes; `over`, `via`, the label and the body stay as written. Matching
 * is by local id at either end, as `deleteRelation` does.
 */
export function retargetRelation(src: string, from: string, verb: string, to: string, end: 'from' | 'to', newId: string): string {
  const { doc } = parse(src);
  let hit: Rel | undefined;
  const walk = (nodes: Node[], parent: string | undefined) => {
    for (const n of nodes) {
      if (hit) return;
      if (n.type === 'decl') { walk((n as Decl).body ?? [], (n as Decl).id); continue; }
      if (n.type !== 'rel') continue;
      const r = n as Rel;
      const f = (r.subject ?? parent ?? '').split('.').pop(), t = r.object.split('.').pop();
      if (f === from && t === to && (r.canonicalVerb === verb || r.verb === verb)) hit = r;
    }
  };
  walk(doc.body, undefined);
  if (!hit) return src;
  // the end's token: the subject is the first word of the statement, the object follows the verb
  const words = hit.tokens.filter(t => t.kind === 'word' || t.kind === 'number' || t.kind === 'pointer');
  const verbIdx = words.findIndex(t => t.text === hit!.verb);
  const tok = end === 'from' ? (hit.subject ? words[0] : undefined) : words[verbIdx + 1];
  if (!tok) {
    // an implicit subject (`calls x` inside a body) cannot be retargeted in place: write it out
    if (end === 'from') {
      const s = span(hit.tokens);
      const lines = src.split('\n');
      const line = lines[s.start - 1]!;
      const rest = tokenText(hit.tokens).trim();
      return splice(splice(src, s.start - 1, s.end - s.start + 1, []), s.start - 1, 0, [line.match(/^\s*/)![0] + `${newId} ${rest}`]);
    }
    return src;
  }
  const lines = src.split('\n');
  const line = lines[tok.line - 1]!;
  const col = tok.col - 1;
  return splice(src, tok.line - 1, 1, [line.slice(0, col) + newId + line.slice(col + tok.text.length)]);
}

/** The relation statement whose ends and verb match, by local id at either end. */
function findRelation(doc: Doc, from: string, verb: string, to: string): Rel | undefined {
  let hit: Rel | undefined;
  const walk = (nodes: Node[], parent: string | undefined) => {
    for (const n of nodes) {
      if (hit) return;
      if (n.type === 'decl') { walk((n as Decl).body ?? [], (n as Decl).id); continue; }
      if (n.type !== 'rel') continue;
      const r = n as Rel;
      const f = (r.subject ?? parent ?? '').split('.').pop(), t = r.object.split('.').pop();
      if (f === from && t === to && (r.canonicalVerb === verb || r.verb === verb)) hit = r;
    }
  };
  walk(doc.body, undefined);
  return hit;
}

/** Replace one token's text in place. */
const swapToken = (src: string, tok: Token, text: string): string => {
  const lines = src.split('\n');
  const line = lines[tok.line - 1]!, col = tok.col - 1;
  return splice(src, tok.line - 1, 1, [line.slice(0, col) + text + line.slice(col + tok.text.length)]);
};

/** `a calls b` → `a uses b`: only the verb changes, everything else stays as written. */
export function setRelationVerb(src: string, from: string, verb: string, to: string, newVerb: string): string {
  const hit = findRelation(parse(src).doc, from, verb, to);
  if (!hit) return src;
  const tok = hit.tokens.find(t => t.kind === 'word' && t.text === hit.verb);
  return tok ? swapToken(src, tok, newVerb) : src;
}

/**
 * Set, change or drop (`value` null) an inline fact of a relation: `over`,
 * `via`, `port`, `spec`, `as`, or the quoted `label`. A fact that is there is
 * rewritten where it stands; a new one goes at the end of the statement's
 * first line, before the body. `via` takes a comma-separated list.
 */
export function setRelationAttr(src: string, from: string, verb: string, to: string, key: 'over' | 'via' | 'port' | 'spec' | 'as' | 'label', value: string | null): string {
  const hit = findRelation(parse(src).doc, from, verb, to);
  if (!hit) return src;
  const first = hit.tokens[0]!.line;
  const onLine = hit.tokens.filter(t => t.line === first && t.kind !== 'newline' && t.kind !== 'lbrace');
  const quote = (v: string) => (/[\s"#{}]/.test(v) || !v ? JSON.stringify(v) : v);
  let start = -1, end = -1;                       // token range of the existing fact, inclusive
  if (key === 'label') {
    const i = onLine.findIndex(t => t.kind === 'string');
    if (i >= 0) { start = i; end = i; }
  } else {
    const i = onLine.findIndex(t => t.kind === 'word' && t.text === key);
    if (i >= 0) {
      start = i; end = i;
      // the values: one token, or a comma-separated list
      if (i + 1 < onLine.length && !RELATION_MODIFIER_WORDS.has(onLine[i + 1]!.text)) end = i + 1;
      while (end + 2 < onLine.length && onLine[end + 1]!.kind === 'comma') end += 2;
    }
  }
  const text = value === null ? '' : key === 'label' ? JSON.stringify(value) : `${key} ${key === 'via' ? value.split(/\s*,\s*/).map(quote).join(', ') : quote(value)}`;
  const lines = src.split('\n');
  const line = lines[first - 1]!;
  if (start >= 0) {
    const a = onLine[start]!.col - 1, b = onLine[end]!.col - 1 + onLine[end]!.text.length;
    const before = line.slice(0, a), after = line.slice(b);
    return splice(src, first - 1, 1, [text ? before + text + after : (before.replace(/\s+$/, '') + (after.trim() ? ' ' + after.trimStart() : after.trimEnd()))]);
  }
  if (!text) return src;
  // append before the body brace or the comment, whichever comes first
  const m = /^(.*?)(\s*\{.*|\s*#.*)?$/.exec(line)!;
  const head = m[1]!.replace(/\s+$/, ''), tail = m[2] ?? '';
  return splice(src, first - 1, 1, [`${head} ${text}${tail}`]);
}
const RELATION_MODIFIER_WORDS = new Set(['over', 'via', 'spec', 'as', 'port']);

export function deleteRelation(src: string, from: string, verb: string, to: string): string {
  const { doc } = parse(src);
  let hit: Rel | undefined;
  each(doc.body, n => {
    if (hit || n.type !== 'rel') return;
    const r = n as Rel;
    if ((r.subject ?? from) === from && r.object === to && (r.canonicalVerb === verb || r.verb === verb)) hit = r;
  });
  if (!hit) return src;
  const s = span(hit.tokens);
  return splice(src, s.start - 1, s.end - s.start + 1, []);
}

/** Lift a declaration back out to the top level. */
/** Leading whitespace shared by every non-blank line — the block's own indent. */
const commonIndent = (lines: string[]): number =>
  Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)![0].length), 0x7fffffff) || 0;

const reindent = (lines: string[], to: string): string[] => {
  const drop = commonIndent(lines);
  return lines.map(l => (l.trim() ? to + l.slice(drop) : ''));
};

/**
 * Move a declaration one level up: a component leaves its container for the
 * system, a container leaves its system for the top level. The text keeps its
 * inner shape — only the common indent changes.
 */
function parentDeclOf(doc: Doc, d: Decl): Decl | undefined {
  const walk = (nodes: Node[], parent?: Decl): Decl | undefined => {
    for (const n of nodes) {
      if (n === d) return parent;
      if (n.type === 'decl' && n.body) { const r = walk(n.body, n); if (r) return r; }
    }
    return undefined;
  };
  return walk(doc.body);
}

export function moveOut(src: string, id: string): string {
  const { doc } = parse(src);
  const d = findDecl(doc, id);
  if (!d) return src;
  const parent = parentDeclOf(doc, d);
  const grand = parent ? parentDeclOf(doc, parent) : undefined;
  if (grand) return moveInto(src, id, grand.id);
  const ds = span(d.tokens);
  const text = reindent(src.split('\n').slice(ds.start - 1, ds.end), '');
  let out = splice(src, ds.start - 1, ds.end - ds.start + 1, []);
  // An emptied block would leave `system shop { }` behind — tidy it away.
  out = out.replace(/^([ \t]*\w+[^\n{]*)\{\s*\n\s*\}[ \t]*$/gm, (_m, head) => head.replace(/\s+$/, ''));
  const at = insertPoint(out);
  const before = out.split('\n')[at - 1];
  return splice(out, at, 0, [...(before && before.trim() ? [''] : []), ...text]);
}

/** Move a declaration inside a system's block, creating the block if needed. */
export function moveInto(src: string, id: string, parentId: string): string {
  const { doc } = parse(src);
  const d = findDecl(doc, id), target = findDecl(doc, parentId);
  if (!d || !target || d === target) return src;
  const ds = span(d.tokens);
  const raw = src.split('\n').slice(ds.start - 1, ds.end);
  let out = splice(src, ds.start - 1, ds.end - ds.start + 1, []);
  out = out.replace(/^([ \t]*\w+[^\n{]*)\{\s*\n\s*\}[ \t]*$/gm, (_m, head) => head.replace(/\s+$/, ''));

  const { doc: d2 } = parse(out);
  const t2 = findDecl(d2, parentId);
  if (!t2) return src;
  const ts = span(t2.tokens);
  const lines = out.split('\n');
  const indent = lines[ts.start - 1]!.match(/^[ \t]*/)![0] + '  ';
  const text = reindent(raw, indent);
  const head = lines[ts.start - 1]!;
  if (t2.body && ts.end === ts.start) {
    // one-line body `{ region ru }` opens up to hold a member
    const open = head.indexOf('{'), close = head.lastIndexOf('}');
    const inner = head.slice(open + 1, close).trim();
    return splice(out, ts.start - 1, 1,
      [head.slice(0, open).replace(/\s*$/, '') + ' {', ...(inner ? [indent + inner] : []), ...text, indent.slice(2) + '}']);
  }
  if (t2.body) return splice(out, ts.start, 0, text);
  return splice(out, ts.start - 1, 1, [head.replace(/\s*$/, '') + ' {', ...text, indent.slice(2) + '}']);
}

/**
 * Place a logical object on a host: `run <ref> [sizing]` goes into the host's
 * body. A host without a body gets one; a one-line body opens up.
 */
export function addRun(src: string, hostId: string, ref: string, sizing = ''): string {
  const { doc } = parse(src);
  const host = findDecl(doc, hostId);
  if (!host) return src;
  if ((host.body ?? []).some(n => n.type === 'run' && (n as Run).refs.includes(ref))) return src;
  const hs = span(host.tokens);
  const lines = src.split('\n');
  const head = lines[hs.start - 1]!;
  const indent = head.match(/^[ \t]*/)![0] + '  ';
  const line = indent + ['run', ref, sizing.trim()].filter(Boolean).join(' ');
  if (host.body && hs.end === hs.start) {
    const open = head.indexOf('{'), close = head.lastIndexOf('}');
    const inner = head.slice(open + 1, close).trim();
    return splice(src, hs.start - 1, 1,
      [head.slice(0, open).replace(/\s*$/, '') + ' {', ...(inner ? [indent + inner] : []), line, indent.slice(2) + '}']);
  }
  if (host.body) return splice(src, hs.end - 1, 0, [line]);       // before the closing brace
  return splice(src, hs.start - 1, 1, [head.replace(/\s*$/, '') + ' {', line, indent.slice(2) + '}']);
}

/** Take a logical object off a host. A `run a, b` line loses one name; a `run a` line goes. */
export function deleteRun(src: string, hostId: string, ref: string): string {
  const { doc } = parse(src);
  const host = findDecl(doc, hostId);
  const r = (host?.body ?? []).find(n => n.type === 'run' && (n as Run).refs.includes(ref)) as Run | undefined;
  if (!r) return src;
  const rs = span(r.tokens);
  if (r.refs.length > 1) {
    const cur = src.split('\n')[rs.start - 1]!;
    const next = cur.replace(new RegExp(`(run\\s+)([^{]*)`), (_m, kw, list) => {
      const names = list.split(',').map((x: string) => x.trim()).filter((x: string) => x && x !== ref);
      // the sizing words after the last name must survive: split names from the rest
      return kw + list.replace(new RegExp(`\\b${ref}\\b\\s*,\\s*|,\\s*\\b${ref}\\b`), '').replace(/^\s+/, '') || names.join(', ');
    });
    return splice(src, rs.start - 1, 1, [next]);
  }
  let out = splice(src, rs.start - 1, rs.end - rs.start + 1, []);
  out = out.replace(/^([ \t]*\w+[^\n{]*)\{\s*\n\s*\}[ \t]*$/gm, (_m, head) => head.replace(/\s+$/, ''));
  return out;
}

/** Re-size a placement: `run checkout` → `run checkout replicas 3 cpu 2`. A shared line is split first. */
export function setRunSizing(src: string, hostId: string, ref: string, sizing: string): string {
  const out = deleteRun(src, hostId, ref);
  return addRun(out === src && !hasRun(src, hostId, ref) ? src : out, hostId, ref, sizing);
}

function hasRun(src: string, hostId: string, ref: string): boolean {
  const { doc } = parse(src);
  const host = findDecl(doc, hostId);
  return (host?.body ?? []).some(n => n.type === 'run' && (n as Run).refs.includes(ref));
}
