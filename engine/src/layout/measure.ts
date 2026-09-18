import { footerOf } from '../lens.js';
/** Text metrics without a browser: good-enough advance widths for the UI font. */
const NARROW = new Set([...'iljtfrI1.,:;\'"|!()[]{}']);
const WIDE = new Set([...'MWmw@']);

export function textWidth(s: string, size: number): number {
  let u = 0;
  for (const ch of s) u += NARROW.has(ch) ? 0.40 : WIDE.has(ch) ? 0.95 : 0.56;
  return u * size;
}

export interface Box { w: number; h: number }

/** Extra room a shape needs beyond its text: a head, a cylinder cap. */
export const SHAPE_PAD: Record<string, { top: number; bottom: number }> = {
  actor:     { top: 50, bottom: 10 },
  datastore: { top: 24, bottom: 16 },
  cache:     { top: 24, bottom: 16 },
};

export function nodeBox(label: string, tech: string | undefined, kind: string, meta?: string, agents?: string[]): Box {
  const title = textWidth(label, 13);
  const sub = tech ? textWidth(`[${kind}: ${tech}]`, 10) : textWidth(`[${kind}]`, 10);
  const third = meta ? textWidth(meta, 10) : 0;
  const pad = SHAPE_PAD[kind] ?? { top: 0, bottom: 0 };
  const w = Math.max(kind === 'actor' ? 150 : 158, Math.min(236, Math.max(title, sub, third) + 38));
  // a host card with agents carries a row of chips under its text
  const footer = footerOf({ agents, w, isBoundary: false });
  const h = (tech ? 72 : 60) + (meta ? 14 : 0) + pad.top + pad.bottom + (footer ? footer + 4 : 0);
  return { w, h };
}
