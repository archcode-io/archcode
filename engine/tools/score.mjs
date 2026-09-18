#!/usr/bin/env node
/**
 * Balance-score harness for ArchCode layouts.
 *
 *   node tools/score.mjs [--lens logical|infrastructure] [--kind model|deployment]
 *                        [--strategies a,b,c] [--dump DIR] [--examples 01,04] [--json]
 *
 * Runs parse → lower → applyLens → layout(strategy) on the six reference
 * documents and prints, per strategy × example: aspect, fill, mean edge length,
 * bends/edge, edge–edge crossings, edge–node crossings, label overlaps,
 * alignment and a weighted score (100 = perfect).  --dump writes layout JSON
 * (drawable with tools/draw.py) and SVG per run.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, lower, applyLens, layout, toSvg, labelBox } from '../dist/src/index.js';
import { textWidth, nodeBox } from '../dist/src/layout/measure.js';
import { STRATEGIES } from './strategies.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = process.env.EXAMPLES ?? join(here, '..', '..', 'spec', 'examples');

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const lens = opt('lens', 'logical');
const kind = opt('kind', 'model');
const only = opt('strategies', '').split(',').filter(Boolean);
const exFilter = opt('examples', '').split(',').filter(Boolean);
const dump = opt('dump', '');
const asJson = args.includes('--json');
export const TARGET_ASPECT = +opt('aspect', '1.6');

// ------------------------------------------------------------------ geometry
const segs = pts => { const s = []; for (let i = 1; i < pts.length; i++) s.push([pts[i - 1], pts[i]]); return s; };
const len = ([a, b]) => Math.hypot(b.x - a.x, b.y - a.y);
const rectsOverlap = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const inside = (id, frame) => id !== frame && (id.startsWith(frame + '.') || id.startsWith(frame + '/'));

/** Does segment a-b cut through rectangle r (not merely touch its border)? */
function segCutsRect(a, b, r) {
  const x1 = r.x + 0.5, y1 = r.y + 0.5, x2 = r.x + r.w - 0.5, y2 = r.y + r.h - 0.5;
  // Liang–Barsky clip
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-dx, a.x - x1) || !clip(dx, x2 - a.x) || !clip(-dy, a.y - y1) || !clip(dy, y2 - a.y)) return false;
  return (t1 - t0) * Math.hypot(dx, dy) > 2;   // more than a 2px graze
}

/** Proper crossing of two segments (shared endpoints and collinear overlaps do not count). */
function segsCross(p, q) {
  const [a, b] = p, [c, d] = q;
  const o = (p1, p2, p3) => Math.sign((p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
  return o1 !== o2 && o3 !== o4;
}

// ------------------------------------------------------------------ metrics
export function metrics(l) {
  const leaves = l.nodes.filter(n => !n.isBoundary);
  const frames = l.nodes.filter(n => n.isBoundary);
  const all = l.nodes;
  if (!all.length) return null;
  const minX = Math.min(...all.map(n => n.x)), minY = Math.min(...all.map(n => n.y));
  const maxX = Math.max(...all.map(n => n.x + n.w)), maxY = Math.max(...all.map(n => n.y + n.h));
  const W = maxX - minX, H = maxY - minY;
  const aspect = W / H;
  const fill = leaves.reduce((a, n) => a + n.w * n.h, 0) / (W * H);

  // edges
  let totalLen = 0, bends = 0, xx = 0, xn = 0, xf = 0;
  const edgeSegs = l.edges.map(e => segs(e.points));
  l.edges.forEach((e, i) => {
    const ss = edgeSegs[i];
    totalLen += ss.reduce((a, s) => a + len(s), 0);
    for (let k = 1; k < e.points.length - 1; k++) {
      const a = e.points[k - 1], b = e.points[k], c = e.points[k + 1];
      const d1 = Math.atan2(b.y - a.y, b.x - a.x), d2 = Math.atan2(c.y - b.y, c.x - b.x);
      if (Math.abs(d1 - d2) > 0.05) bends++;
    }
    for (const s of ss) {
      for (const n of leaves) if (n.id !== e.from && n.id !== e.to && segCutsRect(s[0], s[1], n)) xn++;
      for (const f of frames) {
        if (inside(e.from, f.id) || inside(e.to, f.id) || e.from === f.id || e.to === f.id) continue;
        if (segCutsRect(s[0], s[1], f)) xf++;
      }
    }
  });
  for (let i = 0; i < l.edges.length; i++) for (let j = i + 1; j < l.edges.length; j++) {
    const a = l.edges[i], b = l.edges[j];
    for (const s of edgeSegs[i]) for (const t of edgeSegs[j]) if (segsCross(s, t)) xx++;
    void a; void b;
  }
  const nE = Math.max(1, l.edges.length);

  // labels: same boxes the renderer draws
  const labels = l.edges.filter(e => e.label && e.points.length >= 2).map(e => {
    const w = textWidth(e.label, 10) + 12;
    const b = labelBox(e.points, w);
    return { x: b.rectX, y: b.rectY, w, h: 15, e };
  });
  let lbl = 0;
  labels.forEach((b, i) => {
    for (const n of leaves) if (rectsOverlap(b, n, -1)) { lbl++; break; }
    for (const f of frames) if (rectsOverlap(b, { x: f.x, y: f.y, w: f.w, h: 44 }, -1)) { lbl++; break; }
    for (let j = i + 1; j < labels.length; j++) if (rectsOverlap(b, labels[j], -1)) lbl++;
  });

  // node overlaps (hard failure) and member escapes
  let overlap = 0;
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) if (rectsOverlap(leaves[i], leaves[j], -1)) overlap++;
  for (const f of frames) for (const n of leaves) if (inside(n.id, f.id) && !(n.x >= f.x && n.y >= f.y + 40 && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h)) overlap++;

  // alignment: distinct rows / columns among leaves (centres binned to 6px)
  const bin = v => Math.round(v / 6);
  const rows = new Set(leaves.map(n => bin(n.y + n.h / 2))).size;
  const cols = new Set(leaves.map(n => bin(n.x + n.w / 2))).size;
  const n = Math.max(2, leaves.length);
  const align = 1 - (rows + cols - 2) / (2 * n - 2);

  const meanLen = totalLen / nE;
  // ------------------------------------------------ score
  const clamp = v => Math.max(0, Math.min(1, v));
  const pen = {
    aspect: 25 * clamp(Math.abs(Math.log2(aspect / TARGET_ASPECT))),
    fill: 20 * clamp((0.25 - fill) / 0.25),
    edge: 15 * clamp((meanLen - 120) / 300),
    bends: 10 * clamp(bends / nE / 2),
    xx: 15 * clamp(xx / nE),
    xn: 15 * clamp((xn + xf) / nE),
    lbl: 10 * clamp(lbl / Math.max(1, labels.length)),
    align: 5 * (1 - align),
    overlap: 50 * Math.min(1, overlap),
  };
  const score = Math.max(0, 100 - Object.values(pen).reduce((a, b) => a + b, 0));
  return { W: Math.round(W), H: Math.round(H), aspect, fill, meanLen, bends: bends / nE, xx, xn, xf, lbl, labels: labels.length,
           overlap, align, nodes: leaves.length, edges: l.edges.length, score, pen };
}

// ------------------------------------------------------------------ run
export async function scoreAll({ lensName = lens, kindName = kind, strategies = only, examples = exFilter, dumpDir = dump } = {}) {
  const files = readdirSync(EXAMPLES).filter(f => f.endsWith('.arch')).sort()
    .filter(f => !examples.length || examples.some(e => f.startsWith(e)));
  const names = strategies.length ? strategies : Object.keys(STRATEGIES);
  const table = [];
  for (const name of names) {
    const strat = STRATEGIES[name];
    if (!strat) { console.error(`unknown strategy ${name}; known: ${Object.keys(STRATEGIES).join(', ')}`); process.exit(1); }
    for (const f of files) {
      const src = readFileSync(join(EXAMPLES, f), 'utf8');
      const m = lower(parse(src).doc);
      const g = applyLens(m, { lens: lensName, kind: kindName });
      const t0 = performance.now();
      let l;
      try { l = await strat(g, { layout, nodeBox, textWidth, target: TARGET_ASPECT }); }
      catch (err) { table.push({ strategy: name, example: f.slice(0, 2), error: String(err).slice(0, 80) }); continue; }
      const ms = performance.now() - t0;
      const mt = metrics(l);
      table.push({ strategy: name, example: f.slice(0, 2), ms, ...mt });
      if (dumpDir) {
        mkdirSync(dumpDir, { recursive: true });
        writeFileSync(join(dumpDir, `${f.slice(0, 2)}-${name}.json`), JSON.stringify(l));
        writeFileSync(join(dumpDir, `${f.slice(0, 2)}-${name}.svg`), toSvg(l, `${f} · ${name}`));
      }
    }
  }
  return table;
}

const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v ?? ''));
export function printTable(table) {
  const head = ['strategy', 'ex', 'W×H', 'aspect', 'fill', 'edgeLen', 'bends', 'xx', 'xn+xf', 'lbl', 'align', 'ovl', 'ms', 'score'];
  const rows = table.map(r => r.error ? [r.strategy, r.example, 'ERROR: ' + r.error] :
    [r.strategy, r.example, `${r.W}×${r.H}`, fmt(r.aspect), fmt(r.fill), fmt(r.meanLen, 0), fmt(r.bends, 1), r.xx, `${r.xn}+${r.xf}`, `${r.lbl}/${r.labels}`, fmt(r.align), r.overlap, fmt(r.ms, 0), fmt(r.score, 1)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
  const line = r => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  // per-strategy means
  console.log('');
  const by = new Map();
  for (const r of table) if (!r.error) (by.get(r.strategy) ?? by.set(r.strategy, []).get(r.strategy)).push(r);
  const avg = (rs, k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  console.log(['strategy', 'n', 'aspect', 'fill', 'edgeLen', 'bends', 'xx', 'xn+xf', 'lbl', 'ovl', 'ms', 'SCORE'].map((h, i) => h.padEnd(i ? 8 : widths[0])).join('  '));
  for (const [s, rs] of by)
    console.log([s.padEnd(widths[0]), rs.length, fmt(avg(rs, 'aspect')), fmt(avg(rs, 'fill')), fmt(avg(rs, 'meanLen'), 0), fmt(avg(rs, 'bends'), 2),
      fmt(avg(rs, 'xx'), 1), fmt(avg(rs, 'xn') + avg(rs, 'xf'), 1), fmt(avg(rs, 'lbl'), 1), fmt(avg(rs, 'overlap'), 1), fmt(avg(rs, 'ms'), 0), fmt(avg(rs, 'score'), 1)]
      .map((c, i) => String(c).padEnd(i ? 8 : widths[0])).join('  '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const table = await scoreAll();
  if (asJson) console.log(JSON.stringify(table, null, 1));
  else printTable(table);
}
