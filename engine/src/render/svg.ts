import type { Layout, Positioned, RoutedEdge } from '../layout/elk.js';
import { textWidth } from '../layout/measure.js';
import { labelBox, roundedPath } from '../layout/label.js';
import { footerOf, AGENT_ROW } from '../lens.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Colours are a theme, not a constant: the same drawing on a dark canvas in the
 * Playground and on a white page in a document. `dark` is the Playground's own;
 * `light` is for slides, wikis and print.
 */
export type ThemeName = 'dark' | 'light';
export interface Theme {
  bg: string; grid: string;
  palette: Record<string, { fill: string; stroke: string }>;
  fallback: { fill: string; stroke: string };
  over: string;
  edge: string; edgeDerived: string; flow: string; flowDerived: string; labelBg: string;
  text: string; textDim: string; text2: string; meta: string; load: string;
  phase: { fill: string; stroke: string; text: string };
  agent: { fill: string; stroke: string; text: string };
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    bg: '#0A0F16', grid: '#24313F',
    palette: {
      actor:     { fill: '#171526', stroke: '#6B5FA8' },
      external:  { fill: '#141A22', stroke: '#3B4A5C' },
      system:    { fill: '#0E1620', stroke: '#2C6F97' },
      service:   { fill: '#101922', stroke: '#2C6F97' },
      webapp:    { fill: '#101922', stroke: '#2C6F97' },
      app:       { fill: '#101922', stroke: '#2C6F97' },
      component: { fill: '#101922', stroke: '#2C6F97' },
      function:  { fill: '#101922', stroke: '#2C6F97' },
      job:       { fill: '#101922', stroke: '#2C6F97' },
      datastore: { fill: '#0F1B1A', stroke: '#3E8A80' },
      cache:     { fill: '#0F1B1A', stroke: '#3E8A80' },
      gateway:   { fill: '#1E1A12', stroke: '#8A6A2E' },
      broker:    { fill: '#1E1A12', stroke: '#8A6A2E' },
      topic:     { fill: '#1E1A12', stroke: '#8A6A2E' },
      // placement — where things run; a cooler, quieter family than the logic
      env:       { fill: '#121A16', stroke: '#4E7D5C' },
      segment:   { fill: '#121A16', stroke: '#4E7D5C' },
      cluster:   { fill: '#131C19', stroke: '#5B8F6C' },
      managed:   { fill: '#131C19', stroke: '#5B8F6C' },
      node:      { fill: '#141F1B', stroke: '#6AA37C' },
    },
    fallback: { fill: '#101922', stroke: '#3B4A5C' },
    over: '#E0705E',
    edge: '#4A6B85', edgeDerived: '#4FBFB0', flow: '#7FB6DA', flowDerived: '#7FE0D3', labelBg: '#0A0F16',
    text: '#D6DFE9', textDim: '#61717F', text2: '#92A3B4', meta: '#B8C4A8', load: '#7F918F',
    phase: { fill: '#1E1A12', stroke: '#8A6A2E', text: '#E3A44C' },
    agent: { fill: '#141B24', stroke: '#3B4A5C', text: '#9FB0C0' },
  },
  light: {
    bg: '#FFFFFF', grid: '#D9E0E7',
    palette: {
      actor:     { fill: '#EFEDF8', stroke: '#7B6FC0' },
      external:  { fill: '#F2F4F7', stroke: '#8A98A8' },
      system:    { fill: '#E9F2F9', stroke: '#2C6F97' },
      service:   { fill: '#ECF4FA', stroke: '#2C6F97' },
      webapp:    { fill: '#ECF4FA', stroke: '#2C6F97' },
      app:       { fill: '#ECF4FA', stroke: '#2C6F97' },
      component: { fill: '#ECF4FA', stroke: '#2C6F97' },
      function:  { fill: '#ECF4FA', stroke: '#2C6F97' },
      job:       { fill: '#ECF4FA', stroke: '#2C6F97' },
      datastore: { fill: '#E9F5F3', stroke: '#3E8A80' },
      cache:     { fill: '#E9F5F3', stroke: '#3E8A80' },
      gateway:   { fill: '#FBF3E3', stroke: '#B58A3A' },
      broker:    { fill: '#FBF3E3', stroke: '#B58A3A' },
      topic:     { fill: '#FBF3E3', stroke: '#B58A3A' },
      env:       { fill: '#F0F6F2', stroke: '#4E7D5C' },
      segment:   { fill: '#F0F6F2', stroke: '#4E7D5C' },
      cluster:   { fill: '#EBF3ED', stroke: '#5B8F6C' },
      managed:   { fill: '#EBF3ED', stroke: '#5B8F6C' },
      node:      { fill: '#E7F1EA', stroke: '#6AA37C' },
    },
    fallback: { fill: '#F2F4F7', stroke: '#8A98A8' },
    over: '#C8503F',
    edge: '#5A7A93', edgeDerived: '#2E9A8C', flow: '#2C6F97', flowDerived: '#3E8A80', labelBg: '#FFFFFF',
    text: '#16202B', textDim: '#6A7A88', text2: '#4E5F70', meta: '#5E6E4E', load: '#5F726F',
    phase: { fill: '#FBF3E3', stroke: '#B58A3A', text: '#9A6B1A' },
    agent: { fill: '#F1F4F7', stroke: '#B8C4D0', text: '#4E5F70' },
  },
};

function label(n: Positioned, topY: number): string {
  const cx = n.x + n.w / 2;
  const o = [`<text x="${cx}" y="${topY}" class="nt" text-anchor="middle">${esc(n.label)}</text>`];
  o.push(`<text x="${cx}" y="${topY + 15}" class="nk" text-anchor="middle">[${esc(n.kind)}]</text>`);
  if (n.tech) o.push(`<text x="${cx}" y="${topY + 31}" class="nk2" text-anchor="middle">${esc(n.tech)}</text>`);
  if (n.meta) o.push(`<text x="${cx}" y="${topY + (n.tech ? 46 : 31)}" class="nm" text-anchor="middle">${esc(n.meta)}</text>`);
  return o.join('');
}

/** A person, not a coloured rectangle: a generous head over rounded shoulders. */
function actorSvg(n: Positioned, p: { fill: string; stroke: string }): string {
  const cx = n.x + n.w / 2, headR = 19;
  const headCy = n.y + headR + 2;
  const bodyY = headCy + headR + 5;          // a real neck gap, not a dome
  const bodyBottom = n.y + n.h;
  const shoulder = Math.min(34, n.w / 3);   // wide, soft shoulders
  const foot = 12;                          // and rounded feet, not sharp corners
  const body =
    `M${n.x} ${bodyBottom - foot}` +
    ` L${n.x} ${bodyY + shoulder}` +
    ` Q${n.x} ${bodyY} ${n.x + shoulder} ${bodyY}` +
    ` L${n.x + n.w - shoulder} ${bodyY}` +
    ` Q${n.x + n.w} ${bodyY} ${n.x + n.w} ${bodyY + shoulder}` +
    ` L${n.x + n.w} ${bodyBottom - foot}` +
    ` Q${n.x + n.w} ${bodyBottom} ${n.x + n.w - foot} ${bodyBottom}` +
    ` L${n.x + foot} ${bodyBottom}` +
    ` Q${n.x} ${bodyBottom} ${n.x} ${bodyBottom - foot} Z`;
  return [
    `<circle cx="${cx}" cy="${headCy}" r="${headR}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.6"/>`,
    `<path d="${body}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.6"/>`,
    label(n, bodyY + (n.tech ? 26 : 30)),
  ].join('');
}

/** A cylinder, so a store reads as a store at a glance. */
function storeSvg(n: Positioned, p: { fill: string; stroke: string }): string {
  const ry = 13, cx = n.x + n.w / 2, top = n.y + ry, bot = n.y + n.h - ry;
  const body = `M${n.x} ${top} L${n.x} ${bot} A ${n.w / 2} ${ry} 0 0 0 ${n.x + n.w} ${bot}` +
               ` L${n.x + n.w} ${top} A ${n.w / 2} ${ry} 0 0 0 ${n.x} ${top} Z`;
  return [
    `<path d="${body}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.5"/>`,
    `<ellipse cx="${cx}" cy="${top}" rx="${n.w / 2}" ry="${ry}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.5"/>`,
    `<ellipse cx="${cx}" cy="${top + 7}" rx="${n.w / 2 - 9}" ry="${ry - 6}" fill="none" stroke="${p.stroke}" stroke-width="0.9" opacity="0.45"/>`,
    label(n, n.y + ry * 2 + (n.tech ? 18 : 24)),   // clear of the cap
  ].join('');
}

/** Does the frame's meta line sit beside the title (true) or wrap under it? */
export function metaFits(n: Positioned): boolean {
  if (!n.meta) return true;
  const lw = textWidth(n.label, 13) * 1.08, kw = textWidth(`[${n.kind}]`, 9.5);
  return n.w >= 300 && 16 + lw + 10 + kw + 24 + textWidth(n.meta, 10) * 1.2 + 14 <= n.w;
}

function nodeSvg(n: Positioned, th: Theme): string {
  return `<g class="node" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}"`
       + `${n.isBoundary ? ' data-boundary="1"' : ''}${n.ref ? ` data-ref="${esc(n.ref)}"` : ''}${n.phase ? ` data-phase="${esc(n.phase)}"` : ''}`
       + `${n.agents?.length ? ` data-footer="${footerOf(n)}"` : ''}${n.isBoundary && !metaFits(n) ? ' data-head="60"' : ''}${n.stage ? ` data-stage="${esc(n.stage)}"` : ''}`
       + ` data-x="${n.x}" data-y="${n.y}" data-w="${n.w}" data-h="${n.h}"><title>${esc([n.label, `[${n.kind}]`, n.tech, n.meta].filter(Boolean).join(' · '))}</title>${nodeShape(n, th)}${phaseTag(n)}</g>`;
}

/**
 * Agents installed on a host (`agent antivirus, alloy`) — a row of small chips
 * along the bottom of the frame, wrapping upward when the frame is narrow. They
 * are software on the box that is not part of the model: read at a glance,
 * never connected.
 */
function agentChips(n: Positioned): string {
  if (!n.agents?.length) return '';
  const rows = footerOf(n) / AGENT_ROW;
  const bottom = n.isBoundary ? 6 : 8;   // a card's chips sit a little further in than a frame's
  const o: string[] = [];
  let x = n.x + 14, row = 0;                 // rows fill top-down; the last row sits on the frame's bottom edge
  const maxX = n.x + n.w - 14 - (n.load && rows === 1 ? textWidth(n.load, 10) * 1.2 + 16 : 0);
  for (const a of n.agents) {
    const w = textWidth(a, 9) + 12;
    if (x + w > maxX && x > n.x + 14 && row < rows - 1) { x = n.x + 14; row++; }
    const y = n.y + n.h - bottom - (rows - row) * AGENT_ROW + 4;
    o.push(`<g class="ag"><rect x="${x}" y="${y}" width="${w}" height="16" rx="4"/><text x="${x + w / 2}" y="${y + 11.5}" text-anchor="middle">${esc(a)}</text></g>`);
    x += w + 6;
  }
  return o.join('');
}

/** A small tag in the corner: this thing belongs to one variant of the architecture. */
function phaseTag(n: Positioned): string {
  if (!n.phase) return '';
  const w = textWidth(n.phase, 9) + 10;
  const x = n.x + n.w - w - 6, y = n.y - 7;
  return `<g class="ph"><rect x="${x}" y="${y}" width="${w}" height="14" rx="7"/>`
       + `<text x="${x + w / 2}" y="${y + 10}" text-anchor="middle">${esc(n.phase)}</text></g>`;
}

function nodeShape(n: Positioned, th: Theme): string {
  const p = th.palette[n.kind] ?? th.fallback;

  if (n.isBoundary) {
    const stroke = n.over ? th.over : p.stroke;
    const o = [`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${p.fill}" stroke="${stroke}" stroke-width="${n.over ? 1.8 : 1.3}" stroke-dasharray="6 4"/>`];
    const lw = textWidth(n.label, 13) * 1.08, kw = textWidth(`[${n.kind}]`, 9.5);
    o.push(`<text x="${n.x + 16}" y="${n.y + 26}" class="bl">${esc(n.label)}</text>`);
    o.push(`<text x="${n.x + 16 + lw + 10}" y="${n.y + 26}" class="bk">[${esc(n.kind)}]</text>`);   // bold runs wider
    if (n.meta) {
      // beside the title when there is room, under it when the frame is narrow
      const fits = metaFits(n);
      o.push(fits
        ? `<text x="${n.x + n.w - 14}" y="${n.y + 26}" class="nm" text-anchor="end">${esc(n.meta)}</text>`
        : `<text x="${n.x + 16}" y="${n.y + 41}" class="nm">${esc(n.meta)}</text>`);
    }
    if (n.load) o.push(`<text x="${n.x + n.w - 14}" y="${n.y + n.h - 10}" class="${n.over ? 'ld over' : 'ld'}" text-anchor="end">${esc(n.load)}</text>`);
    o.push(agentChips(n));
    return o.join('');
  }

  if (n.kind === 'actor') return actorSvg(n, p);
  if (n.kind === 'datastore' || n.kind === 'cache') return storeSvg(n, p);

  const dash = n.transit ? ' stroke-dasharray="7 3"' : '';
  return `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.5"${dash}/>`
       + label(n, n.y + (n.tech ? 26 : 30)) + agentChips(n);
}

function edgeSvg(e: RoutedEdge, hit: boolean, th: Theme): string {
  if (e.points.length < 2) return '';
  const d = roundedPath(e.points);
  const stroke = e.derived ? th.edgeDerived : th.edge;
  const dash = e.dashed ? ' stroke-dasharray="5 4"' : '';
  const o = [`<path class="ep" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4"${dash} marker-end="url(#ar${e.derived ? 'd' : ''})"/>`,
    // A second, invisible-by-default path carries the flow animation, so the
    // dash pattern of the real edge is never disturbed by it.
    `<path class="flow" d="${d}" fill="none" stroke="${e.derived ? th.flowDerived : th.flow}" stroke-width="2.1" stroke-linecap="round"/>`];
  if (e.label) {
    // Centred on the connector by length, so the text sits in the middle of the
    // line the reader is following rather than beside whichever bend came out
    // in the middle of the point list.
    const w = textWidth(e.label, 10) + 12;
    // The layout engine reserved a spot for this label where nothing else sits;
    // use it when there is one. A route drawn by hand (pins, live drag) has no
    // such spot, so the label goes to the middle of the line by length.
    const b = e.labelPos
      ? { rectX: e.labelPos.x - 2, rectY: e.labelPos.y - 1, textX: e.labelPos.x - 2 + w / 2, textY: e.labelPos.y + 10, anchor: 'middle' as const }
      : labelBox(e.points, w, e.labelAt ?? 0.5, !!e.labelFlip);
    o.push(`<rect class="elbg" x="${b.rectX}" y="${b.rectY}" width="${w}" height="15" rx="3" fill="${th.labelBg}" opacity="0.9"/>`);
    o.push(`<text class="el" x="${b.textX}" y="${b.textY}" text-anchor="${b.anchor}">${esc(e.label)}</text>`);
  }
  // an editor wants a wide, invisible stroke to grab the arrow by
  if (hit) o.push(`<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="14"/>`);
  return `<g class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-verb="${esc(e.verb)}"${e.labelAt !== undefined ? ` data-labelat="${e.labelAt}"` : ''}${e.labelFlip ? ' data-labelflip="1"' : ''}>${o.join('')}</g>`;
}

/**
 * `hit`: wide invisible strokes for an editor to grab arrows by. `theme`: the
 * colours. `fonts`: CSS (usually `@font-face` rules with data: URIs) written
 * into the picture's own <style>, so a file opened elsewhere keeps its faces.
 * `name`: what the picture is, for the <title> a screen reader or a hover
 * announces (the `title` argument is the caption printed on the picture).
 */
export function toSvg(l: Layout, title: string, opts: { hit?: boolean; theme?: ThemeName; fonts?: string; name?: string } = {}): string {
  const th = THEMES[opts.theme ?? 'dark'];
  // The viewBox follows the content, wherever the content happens to be.
  // Rewriting coordinates to start at zero would make every pinned diagram jump
  // by a constant the moment the first card is pinned.
  const pad = 26;
  const xs = l.nodes.flatMap(n => [n.x, n.x + n.w]).concat(l.edges.flatMap(e => e.points.map(p => p.x)));
  const ys = l.nodes.flatMap(n => [n.y, n.y + n.h]).concat(l.edges.flatMap(e => e.points.map(p => p.y)));
  const minX = (xs.length ? Math.min(...xs) : 0) - pad;
  const minY = (ys.length ? Math.min(...ys) : 0) - pad - (title ? 26 : 0);
  const w = Math.max(1, (xs.length ? Math.max(...xs) : 1) + pad - minX);
  const h = Math.max(1, (ys.length ? Math.max(...ys) : 1) + pad - minY);

  // `data-bounds` carries the content extent separately from the viewBox, so a
  // host that drives its own pan and zoom can fit the drawing without letting
  // the browser rescale it behind its back.
  const name = opts.name ?? `ArchCode diagram — ${l.nodes.length} objects, ${l.edges.length} relations`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}"`
       + ` width="${Math.ceil(w)}" height="${Math.ceil(h)}" data-bounds="${minX} ${minY} ${w} ${h}" data-theme="${opts.theme ?? 'dark'}" role="img" aria-label="${esc(name)}">
<title>${esc(name)}</title>
<defs>
 <marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
   <path d="M0.5 0.8 L7.2 4 L0.5 7.2" fill="none" stroke="${th.edge}" stroke-width="1.3"/></marker>
 <marker id="ard" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
   <path d="M0.5 0.8 L7.2 4 L0.5 7.2" fill="none" stroke="${th.edgeDerived}" stroke-width="1.3"/></marker>
 <pattern id="acgrid" width="24" height="24" patternUnits="userSpaceOnUse">
   <circle cx="1.3" cy="1.3" r="1.3" fill="${th.grid}"/></pattern>
 <style>
  ${opts.fonts ?? ''}
  text{font-family:'IBM Plex Sans',-apple-system,system-ui,sans-serif}
  .nt{font-size:13px;font-weight:600;fill:${th.text}}
  .nk{font-size:9.5px;fill:${th.textDim};font-family:'IBM Plex Mono',ui-monospace,monospace}
  .nk2{font-size:10px;fill:${th.text2}}
  .nm{font-size:10px;fill:${th.meta};font-variant-numeric:tabular-nums}
  .ld{font-size:9.5px;fill:${th.load};font-family:'IBM Plex Mono',ui-monospace,monospace}
  .ld.over{fill:${th.over};font-weight:600}
  .ph rect{fill:${th.phase.fill};stroke:${th.phase.stroke};stroke-width:1}
  .ph text{font-size:9px;fill:${th.phase.text};font-family:'IBM Plex Mono',ui-monospace,monospace}
  .ag rect{fill:${th.agent.fill};stroke:${th.agent.stroke};stroke-width:1}
  .ag text{font-size:9px;fill:${th.agent.text};font-family:'IBM Plex Mono',ui-monospace,monospace}
  .bl{font-size:13px;font-weight:600;fill:${th.text}}
  .bk{font-size:9.5px;fill:${th.textDim};font-family:'IBM Plex Mono',ui-monospace,monospace}
  .el{font-size:10px;fill:${th.text2};font-family:'IBM Plex Mono',ui-monospace,monospace}
  .ttl{font-size:11px;fill:${th.textDim};font-family:'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.12em}
  /* stage (§17.4): a sketch or a proposal is drawn dashed, a deprecated thing dimmed */
  .node[data-stage="sketch"] > rect,.node[data-stage="sketch"] > path,.node[data-stage="sketch"] > circle,.node[data-stage="sketch"] > ellipse,
  .node[data-stage="proposed"] > rect,.node[data-stage="proposed"] > path,.node[data-stage="proposed"] > circle,.node[data-stage="proposed"] > ellipse{stroke-dasharray:4 3}
  .node[data-stage="deprecated"]{opacity:.5}
  .flow{opacity:0;stroke-dasharray:9 999;stroke-dashoffset:0}
  svg.flowing .flow{opacity:.95;animation:acflow 2.4s linear infinite}
  @keyframes acflow{to{stroke-dashoffset:-1008}}
  /* Labels and the animation path must never swallow a click meant for a card. */
  .el,.elbg,.flow,.ttl{pointer-events:none}
  .node{cursor:default}
  svg.draggable .node{cursor:grab}
  svg.draggable .node.dragging{cursor:grabbing}
 </style>
</defs>
<g class="viewport">
<rect class="acgrid" x="-6000" y="-6000" width="14000" height="14000" fill="url(#acgrid)"/>
${title ? `<text x="${minX + 14}" y="${minY + 20}" class="ttl">${esc(title.toUpperCase())}</text>` : ''}
${l.nodes.filter(n => n.isBoundary).map(n => nodeSvg(n, th)).join('\n')}
<g class="edges">${l.edges.map(e => edgeSvg(e, !!opts.hit, th)).join('\n')}</g>
${l.nodes.filter(n => !n.isBoundary).map(n => nodeSvg(n, th)).join('\n')}
</g></svg>`;
}
