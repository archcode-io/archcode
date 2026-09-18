import { lex } from './lexer.js';
import type { Token } from './tokens.js';
import type { Attr, Blank, Decl, Doc, Iface, Node, Raw, Rel, Run } from './cst.js';
import { ATTR_KEYS, FLAG_ATTRS, OBJECT_KINDS, IFACE_VERBS, OPAQUE_KINDS, PAIR_KEYS, RELATION_MODIFIERS, RUN, RUN_KEYS, VERBS, VERB_SUGAR } from './vocab.js';
import { diag, type Diagnostic } from './diagnostics.js';

export interface ParseResult {
  doc: Doc;
  diagnostics: Diagnostic[];
}

const unquote = (s: string) =>
  s.startsWith('"') ? s.slice(1, s.endsWith('"') && s.length > 1 ? -1 : undefined).replace(/\\(.)/g, '$1') : s;

class Parser {
  private i = 0;
  readonly diagnostics: Diagnostic[] = [];
  /** Every id declared anywhere in the document — one cheap pass before parsing. */
  private readonly declared = new Set<string>();
  constructor(private readonly t: Token[]) {
    for (let k = 0; k + 1 < t.length; k++)
      if (t[k]!.kind === 'word' && OBJECT_KINDS.has(t[k]!.text) && t[k + 1]!.kind === 'word') this.declared.add(t[k + 1]!.text);
  }

  private peek(k = 0): Token { return this.t[Math.min(this.i + k, this.t.length - 1)]!; }
  private at(kind: string, k = 0): boolean { return this.peek(k).kind === kind; }
  private next(): Token { return this.t[this.i++] ?? this.t[this.t.length - 1]!; }
  private slice(from: number): Token[] { return this.t.slice(from, this.i); }

  /** Words on the current logical line, used to decide the statement shape. */
  private lineWords(): Token[] {
    const out: Token[] = [];
    for (let k = this.i; k < this.t.length; k++) {
      const tok = this.t[k]!;
      if (tok.kind === 'newline' || tok.kind === 'eof' || tok.kind === 'lbrace' || tok.kind === 'rbrace') break;
      out.push(tok);
    }
    return out;
  }

  parseDoc(): Doc {
    const body: Node[] = [];
    while (!this.at('eof')) body.push(this.parseStatement());
    const eof = this.next();
    return { type: 'doc', body, tokens: this.t.slice(), tail: [eof] } as Doc & { tail: Token[] };
  }

  /** Consume the newline that terminates a statement, if present. */
  private eatEol(): void { if (this.at('newline')) this.next(); }

  /** True while parsing a body opened and closed on one line: `{ transit  auth oidc }`. */
  private oneLine = false;

  private parseStatement(): Node {
    if (this.at('newline')) {
      const from = this.i; this.next();
      return { type: 'blank', tokens: this.slice(from) } as Blank;
    }

    const words = this.lineWords();
    const first = words[0];

    if (!first) { // stray '{' or '}' at statement position
      const from = this.i; this.next(); this.eatEol();
      const t = this.t[from]!;
      this.diagnostics.push(diag('error', 'AC001', `unexpected \`${t.text}\``, t.line, t.col));
      return { type: 'blank', tokens: this.slice(from) } as Blank;
    }

    if (first.kind === 'word' && OBJECT_KINDS.has(first.text)) return this.parseDecl();
    if (first.kind === 'word' && first.text === RUN && words[1]?.kind === 'word') return this.parseRun();

    const second = words[1];
    // `checkout calls billing` is a relation; `capacity calls 20000/day` is an
    // attribute whose value happens to be a verb. A declared id or a dotted
    // path is a subject; a known attribute key is not.
    const subjectLike = !ATTR_KEYS.has(first.text) || this.declared.has(first.text) || first.text.includes('.');
    if (second && second.kind === 'word' && VERBS.has(second.text) && subjectLike) return this.parseRel(true);
    if (first.kind === 'word' && VERBS.has(first.text)) return this.parseRel(false);
    if (second && second.kind === 'word' && IFACE_VERBS.has(second.text) && subjectLike) return this.parseIface(true);
    if (first.kind === 'word' && IFACE_VERBS.has(first.text)) return this.parseIface(false);

    return this.parseAttr(this.oneLine);
  }

  private parseDecl(): Decl {
    const from = this.i;
    const kind = this.next().text;

    let id = '';
    if (this.at('word')) id = this.next().text;
    else {
      const t = this.peek();
      this.diagnostics.push(diag('error', 'AC002', `\`${kind}\` needs an identifier`, t.line, t.col));
    }

    let name: string | undefined;
    if (this.at('string')) name = unquote(this.next().text);

    const inline: Attr[] = [];
    while (!this.at('newline') && !this.at('eof') && !this.at('lbrace') && !this.at('rbrace')) {
      inline.push(this.parseAttr(/*inline*/ true));
    }

    let body: Node[] | undefined;
    if (this.at('lbrace')) body = OPAQUE_KINDS.has(kind) ? this.parseRawBlock() : this.parseBlock(id);
    else this.eatEol();

    return { type: 'decl', kind, id, name, inline, body, tokens: this.slice(from) };
  }

  /** `{ … }` of a reserved or `view` block: balanced braces, nothing interpreted. */
  private parseRawBlock(): Node[] {
    const open = this.next();                                   // '{'
    const from = this.i;
    let depth = 1;
    while (!this.at('eof')) {
      if (this.at('lbrace')) depth++;
      else if (this.at('rbrace') && --depth === 0) break;
      this.next();
    }
    const raw: Raw = { type: 'raw', tokens: this.slice(from) };
    if (this.at('rbrace')) { this.next(); this.eatEol(); }
    else this.diagnostics.push(diag('error', 'AC003', 'unclosed `{`', open.line, open.col));
    return [raw];
  }

  /** `run <ref>[, <ref>…] [sizing…] [{ body }]` */
  private parseRun(): Run {
    const from = this.i;
    this.next();                                   // `run`
    const refs: string[] = [this.next().text];
    while (this.at('comma')) { this.next(); if (this.at('word')) refs.push(this.next().text); }
    const attrs: Attr[] = [];
    // Inline, a run takes its sizing (`run api 3 cpu 2`) and its phase; in a
    // one-line host body (`{ run s3  agent restic }`) anything else is the host's.
    while (!this.at('newline') && !this.at('eof') && !this.at('lbrace') && !this.at('rbrace')
      && (!this.oneLine || RUN_KEYS.has(this.peek().text)))
      attrs.push(this.parseAttr(/*inline*/ true));
    let body: Node[] | undefined;
    if (this.at('lbrace')) body = this.parseBlock(refs[0]!);
    else if (!this.oneLine) this.eatEol();
    return { type: 'run', refs, attrs, body, tokens: this.slice(from) };
  }

  private parseBlock(_owner: string): Node[] {
    this.next();                       // '{'
    const body: Node[] = [];
    // A body that starts on the same line as its `{` holds attributes side by
    // side, exactly like the declaration line does; a body that opens with a
    // newline holds one statement per line.
    const outer = this.oneLine;
    this.oneLine = !this.at('newline');
    while (!this.at('rbrace') && !this.at('eof')) body.push(this.parseStatement());
    this.oneLine = outer;
    if (this.at('rbrace')) { this.next(); this.eatEol(); }
    else {
      const t = this.peek();
      this.diagnostics.push(diag('error', 'AC003', 'unclosed `{`', t.line, t.col));
    }
    return body;
  }

  /** `key value[, value…]`. In inline mode, stops after one key/value group. */
  private parseAttr(inline = false): Attr {
    const from = this.i;
    const keyTok = this.next();
    const values: string[] = [];

    const readValue = () => {
      const v = this.next();
      values.push(v.kind === 'string' ? unquote(v.text) : v.text);
    };

    // A flag takes no value when it sits beside other attributes (`transit  auth oidc`)
    const flag = inline && FLAG_ATTRS.has(keyTok.text) && !/^(true|false)$/.test(this.peek().text);
    const stop = () => this.at('newline') || this.at('eof') || this.at('lbrace') || this.at('rbrace');
    // Several pairs may share a line — `dc dc1  vlan 3076`, `host x  ip y  os "z"`,
    // `tech Go 1.21  cpu 2` — so a value list ends where the next known key
    // begins (spec §6.1, D-305/A3). `at` is the exception: its line is one
    // moment with its own pairs inside. On its own line an unknown word is
    // still a value (`capacity rps 300 p99 250ms`); inline, beside other
    // attributes, an unknown word starts the next attribute (`auth oidc`) —
    // there, only numbers and strings continue a value (`tech Go 1.21`).
    // `capacity` carries its own open-ended pairs (`rps 300 p99 250ms`), inline too
    const greedy = keyTok.text === 'at', open = keyTok.text === 'capacity';
    const opensPair = () => !greedy && values.length > 0 && this.peek().kind === 'word' && (PAIR_KEYS.has(this.peek().text) || (inline && !open));
    if (!flag && !stop()) readValue();
    while (!flag && !stop()) {
      if (this.at('comma')) { this.next(); if (!stop()) readValue(); continue; }
      if (opensPair()) break;
      readValue();
    }
    if (!inline) this.eatEol();
    return { type: 'attr', key: keyTok.text, values, tokens: this.slice(from) };
  }

  /** `exposes http openapi://checkout.yaml @9f3c2e1 "label" { … }` — see Iface. */
  private parseIface(explicitSubject: boolean): Iface {
    const from = this.i;
    const subject = explicitSubject ? this.next().text : undefined;
    const verbTok = this.next();
    const verb = verbTok.text as Iface['verb'];
    let kind = '';
    if (this.at('word')) kind = this.next().text;
    else this.diagnostics.push(diag('error', 'AC004', `\`${verb}\` needs an interface kind (http, grpc, schema, cli…)`, verbTok.line, verbTok.col));
    let pointer: string | undefined, rev: string | undefined, label: string | undefined;
    while (!this.at('newline') && !this.at('eof') && !this.at('lbrace') && !this.at('rbrace')) {
      const t = this.next();
      if (t.kind === 'string') { label = unquote(t.text); continue; }
      if (t.text.startsWith('@') && pointer !== undefined) { rev = t.text.slice(1); continue; }
      if (pointer === undefined) {
        const at = t.text.includes('://') ? t.text.lastIndexOf('@') : -1;   // `openapi://x.yaml@a1b2c3d`
        if (at > t.text.indexOf('://')) { pointer = t.text.slice(0, at); rev = t.text.slice(at + 1); }
        else pointer = t.text;
        continue;
      }
      this.diagnostics.push(diag('warning', 'AC005', `unexpected \`${t.text}\` after the pointer`, t.line, t.col));
    }
    let body: Node[] | undefined;
    if (this.at('lbrace')) body = this.parseBlock(kind);
    else if (!this.oneLine) this.eatEol();
    return { type: 'iface', subject, verb, kind, pointer, rev, label, body, tokens: this.slice(from) };
  }

  private parseRel(explicitSubject: boolean): Rel {
    const from = this.i;
    const subject = explicitSubject ? this.next().text : undefined;
    const verbTok = this.next();
    const verb = verbTok.text;

    let object = '';
    if (!this.at('newline') && !this.at('eof') && !this.at('lbrace')) object = this.next().text;
    else this.diagnostics.push(diag('error', 'AC004', `\`${verb}\` needs an object`, verbTok.line, verbTok.col));

    let over: string | undefined, via: string[] | undefined, spec: string | undefined,
        as: string | undefined, label: string | undefined, port: string | undefined;

    while (!this.at('newline') && !this.at('eof') && !this.at('lbrace') && !this.at('rbrace')) {
      const t = this.peek();
      if (t.kind === 'string') { label = unquote(this.next().text); continue; }
      if (t.kind === 'word' && RELATION_MODIFIERS.has(t.text)) {
        const mod = this.next().text;
        const vals: string[] = [];
        if (!this.at('newline') && !this.at('eof')) vals.push(this.next().text);
        while (this.at('comma')) { this.next(); if (!this.at('newline') && !this.at('eof')) vals.push(this.next().text); }
        if (mod === 'over') over = vals[0];
        else if (mod === 'via') via = vals;
        else if (mod === 'spec') spec = vals[0];
        else if (mod === 'as') as = vals[0];
        else if (mod === 'port') port = vals[0];
        continue;
      }
      this.diagnostics.push(diag('warning', 'AC005', `unexpected \`${t.text}\` in relation`, t.line, t.col));
      this.next();
    }

    let body: Node[] | undefined;
    if (this.at('lbrace')) body = this.parseBlock(object);
    else this.eatEol();

    return {
      type: 'rel', subject, verb, canonicalVerb: VERB_SUGAR[verb] ?? verb,
      object, over, via, spec, as, port, label, body, tokens: this.slice(from),
    };
  }
}

export function parse(src: string): ParseResult {
  const p = new Parser(lex(src));
  const doc = p.parseDoc();
  return { doc, diagnostics: p.diagnostics };
}
