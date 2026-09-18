import type { Doc } from './cst.js';
import { tokenText } from './tokens.js';

/**
 * Serialize a document back to text.
 *
 * The document owns the complete token stream, and every byte of the source is
 * inside exactly one token (as trivia or as text), so this is byte-exact for
 * any document that came out of `parse`. This is the round-trip invariant of
 * D-27, and it holds structurally rather than by careful bookkeeping.
 */
export function serialize(doc: Doc): string {
  return tokenText(doc.tokens);
}
