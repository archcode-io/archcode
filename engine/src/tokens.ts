/**
 * Lossless token stream.
 *
 * Every byte of the source belongs to exactly one token: either to its `trivia`
 * (whitespace and comments preceding it) or to its `text`. Therefore
 *   tokens.map(t => t.trivia + t.text).join('')
 * reproduces the source byte for byte. This is what makes the round-trip
 * invariant (D-27) structural rather than aspirational.
 */

export type TokenKind =
  | 'word'     // bare identifier or keyword: checkout, service, over
  | 'string'   // "Checkout"
  | 'number'   // 180ms, 4Gi, 16, 99.9%
  | 'pointer'  // openapi://checkout.yaml@abc123
  | 'lbrace'
  | 'rbrace'
  | 'comma'
  | 'newline'
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** Exact source text of the token itself. */
  text: string;
  /** Exact whitespace and comments immediately preceding the token. */
  trivia: string;
  /** Byte offset where `trivia` begins. */
  start: number;
  /** Byte offset just past `text`. */
  end: number;
  /** 1-based line of the token text. */
  line: number;
  /** 1-based column of the token text. */
  col: number;
}

export function tokenText(tokens: readonly Token[]): string {
  let out = '';
  for (const t of tokens) out += t.trivia + t.text;
  return out;
}
