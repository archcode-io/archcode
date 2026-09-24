import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, lower, applyLens, layout, toSvg } from '../src/index.js';

const svgOf = async (src: string, lens: 'logical' | 'infrastructure' = 'logical') =>
  toSvg(await layout(applyLens(lower(parse(src).doc), { lens })), 'a "title" <b>', { hit: true });
// every attribute the renderer writes, by name: an injected one would show up here
const attrNames = (svg: string) => new Set([...svg.matchAll(/\s([a-zA-Z_:][-\w:.]*)=("[^"]*"|'[^']*')/g)].map(m => m[1]!));
const ALLOWED = /^(xmlns|viewBox|width|height|class|id|d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|fill|stroke|stroke-width|stroke-dasharray|stroke-linecap|stroke-linejoin|opacity|marker-end|markerWidth|markerHeight|refX|refY|orient|patternUnits|text-anchor|transform|role|aria-label|font-size|font-weight|href|points|data-[a-z-]+|style)$/;

test('a quote in the document cannot close an attribute (share-link XSS)', async () => {
  const payload = 'x\\" onmouseover=\\"alert(1)\\" y=\\"';
  const src = `system shop "Shop" {\n  service api "A \\"quoted\\" <b>" tech "Go \\" onload=\\"x" {\n    stage "${payload}"\n    phase "${payload}"\n  }\n  datastore db "DB"\n  api writes db "w \\" onclick=\\"x"\n}\n`;
  const svg = await svgOf(src);
  const names = attrNames(svg);
  const bad = [...names].filter(n => !ALLOWED.test(n));
  assert.deepEqual(bad, [], `unexpected attributes: ${bad}`);
  assert.ok(![...names].some(n => /^on/i.test(n)), 'no event-handler attribute anywhere');
  assert.ok(svg.includes('&quot;'), 'quotes are escaped, not dropped');
  assert.ok(!svg.includes('<b>'), 'markup in a label stays text');
});

test('escaping is display-neutral: an ordinary label renders as before', async () => {
  const svg = await svgOf('service api "Orders API" tech Go\n');
  assert.ok(svg.includes('>Orders API<'));
  assert.ok(svg.includes('>Go<'));
});
