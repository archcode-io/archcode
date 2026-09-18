import type { Token } from './tokens.js';

/**
 * Concrete syntax tree. Every node owns a contiguous slice of the token stream,
 * so serialization is concatenation and round-trip is byte-exact by construction.
 */

export type Node = Doc | Decl | Attr | Rel | Run | Iface | Raw | Blank;

export interface Base { tokens: Token[] }

export interface Doc extends Base {
  type: 'doc';
  body: Node[];
  /** The EOF token, which carries any trailing whitespace or comment. */
  tail: Token[];
}

/** `service checkout "Checkout" tech Go { … }` */
export interface Decl extends Base {
  type: 'decl';
  kind: string;
  id: string;
  name?: string;          // display name, unquoted
  inline: Attr[];         // attributes written on the declaration line
  body?: Node[];          // block contents, if `{ … }` present
}

/** `tech Go` · `tags core, sales` */
export interface Attr extends Base {
  type: 'attr';
  key: string;
  values: string[];       // unquoted / normalized values
}

/** `checkout writes orders_db over SQL via gw "label"` */
export interface Rel extends Base {
  type: 'rel';
  subject?: string;       // absent means "the enclosing object" (spec §3.3)
  verb: string;           // as written
  canonicalVerb: string;  // emits → publishes
  object: string;
  over?: string;
  via?: string[];         // chain of transit nodes, in traffic order (D-135)
  spec?: string;          // pointer
  as?: string;            // explicit relation name (D-50)
  port?: string;          // `port 9001` — the number a firewall request asks for
  label?: string;
  body?: Node[];
}

/**
 * `exposes http openapi://checkout.yaml @9f3c2e1` · `stores schema sql://payments.dbml` · `exposes cli`
 * An interface the enclosing object offers (spec §4.3): the kind names the
 * standard, the pointer is an address, never content; `@rev` is the revision
 * the declaration was made against.
 */
export interface Iface extends Base {
  type: 'iface';
  subject?: string;       // absent means "the enclosing object"
  verb: 'exposes' | 'stores';
  kind: string;           // http · grpc · graphql · cli · event · schema …
  pointer?: string;       // `openapi://checkout.yaml` — as written, without the revision
  rev?: string;           // `9f3c2e1` — from `@rev` or a trailing `…@rev` on the pointer
  label?: string;
  body?: Node[];
}

/** `run checkout, fulfillment replicas 6 cpu 2 mem 4Gi { at 2026-12 replicas 12 }` */
export interface Run extends Base {
  type: 'run';
  refs: string[];         // logical objects placed here, as written
  attrs: Attr[];          // inline sizing
  body?: Node[];
}

/** The body of a reserved or `view` block: kept as tokens, read by nobody here. */
export interface Raw extends Base { type: 'raw' }

/** A line that carries no statement: blank, or comment-only. */
export interface Blank extends Base { type: 'blank' }
