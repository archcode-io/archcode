import type { Token, TokenKind } from './tokens.js';

// `@` starts a word so that owner handles (`@team-sales`) are one token rather
// than a stray symbol followed by a name.
const isWordStart = (c: string) => /[A-Za-z_@]/.test(c);
const isWordChar  = (c: string) => /[A-Za-z0-9_.\-]/.test(c);
const isDigit     = (c: string) => c >= '0' && c <= '9';

/**
 * Tokenize losslessly. Never throws: malformed input produces tokens plus
 * diagnostics from the parser, because a broken file must still yield a
 * partial model (D-58).
 */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, col = 1;

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  };

  while (true) {
    // ---- trivia: spaces, tabs, carriage returns, line comments ----
    const triviaStart = i;
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r') { advance(1); continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') advance(1); continue; }
      break;
    }
    const trivia = src.slice(triviaStart, i);
    const tokLine = line, tokCol = col, tokStart = i;

    const push = (kind: TokenKind, text: string) => {
      out.push({ kind, text, trivia, start: triviaStart, end: tokStart + text.length, line: tokLine, col: tokCol });
    };

    if (i >= src.length) { push('eof', ''); return out; }

    const c = src[i]!;

    if (c === '\n') { advance(1); push('newline', '\n'); continue; }
    if (c === '{')  { advance(1); push('lbrace', '{');  continue; }
    if (c === '}')  { advance(1); push('rbrace', '}');  continue; }
    if (c === ',')  { advance(1); push('comma', ',');   continue; }

    if (c === '"') {
      const s = i;
      advance(1);
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < src.length) advance(2); else advance(1);
      }
      if (src[i] === '"') advance(1);          // unterminated string is tolerated
      push('string', src.slice(s, i));
      continue;
    }

    // `+1y`, `+30d`: a relative moment is one value (§6.3), the sign included
    if (isDigit(c) || (c === '+' && isDigit(src[i + 1] ?? ''))) {
      const s = i;
      if (c === '+') advance(1);
      const numeral = () => {
        // digits, then a unit suffix; `24x7`, `3x`, `p99`-style mixes stay one token —
        // a value written without spaces is one value
        while (i < src.length && /[0-9._]/.test(src[i]!)) advance(1);
        while (i < src.length && /[A-Za-z0-9%]/.test(src[i]!)) advance(1);
      };
      numeral();
      // a date `2026-12-01` and a ratio `0.7/2` or `800Mi/2Gi` stay one token:
      // they are one value, and a reader never splits them either
      // …and so does a rate `800Gi/mo`, `20000/day`
      while ((src[i] === '-' && isDigit(src[i + 1] ?? '')) || (src[i] === '/' && /[0-9A-Za-z]/.test(src[i + 1] ?? ''))) {
        advance(1);
        if (isDigit(src[i]!)) numeral();
        else while (i < src.length && /[A-Za-z]/.test(src[i]!)) advance(1);
      }
      push('number', src.slice(s, i));
      continue;
    }

    if (isWordStart(c)) {
      const s = i;
      advance(1);                 // always consume the first character, or a
                                  // start-only character like `@` loops forever
      while (i < src.length && isWordChar(src[i]!)) advance(1);
      // pointer: scheme://rest
      if (src.slice(i, i + 3) === '://') {
        advance(3);
        while (i < src.length && /[^\s,{}]/.test(src[i]!)) advance(1);
        push('pointer', src.slice(s, i));
        continue;
      }
      push('word', src.slice(s, i));
      continue;
    }

    // any other byte becomes a one-character word token so nothing is lost
    advance(1);
    push('word', src.slice(tokStart, i));
  }
}
