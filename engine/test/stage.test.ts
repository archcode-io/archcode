import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, lower, check, applyLens, capacityTable } from '../src/index.js';

const model = (src: string) => { const { doc } = parse(src); const m = lower(doc); return { doc, m }; };

test('stage: a sketch is not scolded, a proposal only warned, retired is not drawn (§17.4)', () => {
  const { doc, m } = model('service a "A" { stage sketch\n  calls nobody }\nservice b "B" { stage proposed }\nservice b "B again" { stage proposed }\nservice r "R" { stage retired }\nservice c "C" tech Go\nc calls r\n');
  const ds = check(doc, m).map(d => `${d.code}:${d.severity}@${d.line}`);
  assert.ok(!ds.some(d => d.endsWith('@2')), 'the sketch line is quiet');
  assert.ok(ds.includes('AC100:warning@4'), `a duplicate under proposed is a warning: ${ds}`);
  const g = applyLens(m, { lens: 'logical' });
  assert.deepEqual(g.roots.map(n => n.id + (n.stage ? ':' + n.stage : '')).sort(), ['a:sketch', 'b:proposed', 'c']);
  assert.equal(g.edges.length, 0, 'an arrow to a retired object is not drawn');
});

test('a collapsed system aggregates what folds into it (§17.2)', () => {
  const src = 'system s "S" {\n  service x\n  service y\n  datastore d\n}\nservice o "O"\no calls x\no calls y\no writes d\nsystem t "T" { service z }\nz uses o\nt calls o "declared"\n';
  const { m } = model(src);
  const g = applyLens(m, { lens: 'logical', collapsed: ['s', 't'] });
  const s = g.roots.find(n => n.id === 's')!;
  assert.equal(s.folded, 3); assert.match(s.meta ?? '', /3 inside/);
  const os = g.edges.filter(e => e.from === 'o' && e.to === 's');
  assert.equal(os.length, 1); assert.equal(os[0]!.verb, 'relates'); assert.equal(os[0]!.label, '3 relations'); assert.equal(os[0]!.derived, true);
  const to = g.edges.filter(e => e.from === 't' && e.to === 'o');
  assert.equal(to.length, 1); assert.equal(to[0]!.verb, 'calls'); assert.equal(to[0]!.label, 'declared · ×1 inside');
});

test('same-verb relations fold into one edge with a count', () => {
  const { m } = model('system s { service x\n service y }\nservice o\no calls x\no calls y\n');
  const g = applyLens(m, { lens: 'logical', collapsed: ['s'] });
  const e = g.edges.filter(x => x.to === 's');
  assert.equal(e.length, 1); assert.equal(e[0]!.verb, 'calls'); assert.equal(e[0]!.label, '×2');
});

test('capacity: what a store holds is a line of its own, growing by the moment', () => {
  const { m } = model('system s {\n  datastore db "DB" { capacity size 300Gi growth 10Gi/mo }\n}\nenv prod {\n  managed pg "PG" { run db }\n  node n1 cpu 2 mem 4Gi disk 100Gi {\n    at +1y count 2\n  }\n}\n');
  const t = capacityTable(m);
  const prod = t.envs.find(e => e.id === 'prod')!;
  const data = prod.rows.find(r => r.kind === 'data')!;
  assert.equal(data.label, 'DB · data');
  assert.equal(data.figures['now']!.disk, 300);
  assert.equal(data.figures['+1y']!.disk, 420);
  assert.equal(data.counted, false);
  assert.equal(prod.totals['now']!.disk, 100, 'data is not summed into host disk');
});
