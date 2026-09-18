import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, lower, applyLens, layout, roundTrips } from '../src/index.js';

const attrs = (src: string, id: string) => lower(parse(src).doc).objects.get(id)!.attrs;

test('a one-line body holds attributes side by side, like the declaration line', () => {
  const src = `gateway gw "GW" { transit  auth oidc }\nbroker k "K" { transit  tech "Kong 3.6" }\n`;
  assert.ok(roundTrips(src));
  assert.deepEqual(attrs(src, 'gw'), { transit: [], auth: ['oidc'] });
  assert.deepEqual(attrs(src, 'k'), { transit: [], tech: ['Kong 3.6'] });
});

test('a flag beside inline attributes takes no value', () => {
  assert.deepEqual(attrs(`gateway gw "GW" transit tech Kong\n`, 'gw'), { transit: [], tech: ['Kong'] });
});

test('a multi-line body still takes a whole line per attribute', () => {
  const src = `service s {\n  tech PostgreSQL 16\n  capacity rps 1200 p99 180ms\n}\n`;
  assert.deepEqual(attrs(src, 's'), { tech: ['PostgreSQL', '16'], capacity: ['rps', '1200', 'p99', '180ms'] });
});

test('the placement example from spec §6 parses without diagnostics', () => {
  const src = `env prod {\n  region ru\n  cluster core { run checkout replicas 6 cpu 2 mem 4Gi }\n` +
    `  managed rds "RDS" { run db disk 2Ti }\n  segment dmz { run api_gw replicas 4 }\n}\n`;
  const { doc, diagnostics } = parse(src);
  assert.equal(diagnostics.length, 0);
  assert.deepEqual([...lower(doc).objects.keys()], ['prod', 'prod.core', 'prod.rds', 'prod.dmz']);
});

test('a store owned by a service that has components stays on the diagram', async () => {
  const src = `system shop {\n  service checkout {\n    component cart\n    component pay\n    cart calls pay\n  }\n` +
    `  datastore db\n  checkout writes db\n}\n`;
  const l = await layout(applyLens(lower(parse(src).doc), { lens: 'logical' }));
  assert.ok(l.nodes.some(n => n.id === 'shop.db'));
  assert.ok(l.edges.some(e => e.from === 'shop.checkout' && e.to === 'shop.db'));
});

test('an attribute whose value is a verb stays an attribute; a declared subject stays a relation', () => {
  const src = `service a\nservice calls_me\nservice b {\n  capacity calls 20000/day sessions 300\n  calls a over HTTPS\n}\ncalls_me calls a\n`;
  const m = lower(parse(src).doc);
  assert.deepEqual(m.objects.get('b')!.attrs['capacity'], ['calls', '20000/day', 'sessions', '300']);
  assert.deepEqual(m.relations.map(r => `${r.from}>${r.to}`), ['b>a', 'calls_me>a']);
});

test('rates and ratios are single tokens; `at` lines keep multi-word sizing', () => {
  const src = `node db cpu 8 {\n  disk data 5Ti\n  at 2026-12 count 2 disk data 15Ti\n}\ndatastore x {\n  capacity size 28Ti growth 800Gi/mo\n}\n`;
  const m = lower(parse(src).doc);
  assert.deepEqual(m.objects.get('db')!.timeline, [{ when: '2026-12', attrs: { count: ['2'], disk: ['data', '15Ti'] } }]);
  assert.deepEqual(m.objects.get('x')!.attrs['capacity'], ['size', '28Ti', 'growth', '800Gi/mo']);
});

test('ids and attribute keys that collide with Object.prototype are just names', () => {
  const m = lower(parse('service constructor "C" constructor 1 toString 2\nservice x\nconstructor calls x\n').doc);
  assert.deepEqual(m.objects.get('constructor')!.attrs, { constructor: ['1'], toString: ['2'] });
  assert.equal(m.relations.length, 1);
});

test('a value written without spaces is one token: 24x7, 3x, 5m', () => {
  const m = lower(parse('system cc owner @t availability 24x7 criticality business_critical rto 5m rpo 1h burst 3x\n').doc);
  const a = m.objects.get('cc')!.attrs;
  assert.deepEqual([a['availability'], a['criticality'], a['rto'], a['rpo'], a['burst']], [['24x7'], ['business_critical'], ['5m'], ['1h'], ['3x']]);
});

test('several pairs share a body line; `at` and unknown keys stay whole (A3)', () => {
  const src = [
    'env prod {',
    '  dc dc1  vlan 3076',
    '  node app "App" tech Go 1.21  cpu 2 {',
    '    host app-01.example  ip 10.0.0.11  os "Debian 12"',
    '    disk system 30Gi data 200Gi',
    '    capacity rps 300 p99 250ms',
    '    at 2026-12 cpu 4 mem 8Gi',
    '    tags data, pii',
    '  }',
    '}',
    '',
  ].join('\n');
  const { doc, diagnostics } = parse(src);
  assert.deepEqual(diagnostics, []);
  const m = lower(doc);
  const e = m.objects.get('prod')!.attrs, a = m.objects.get('prod.app')!;
  assert.deepEqual([e['dc'], e['vlan']], [['dc1'], ['3076']]);
  assert.deepEqual([a.attrs['tech'], a.attrs['cpu']], [['Go', '1.21'], ['2']]);
  assert.deepEqual([a.attrs['host'], a.attrs['ip'], a.attrs['os']], [['app-01.example'], ['10.0.0.11'], ['Debian 12']]);
  assert.deepEqual(a.attrs['disk'], ['system', '30Gi', 'data', '200Gi']);
  assert.deepEqual(a.attrs['capacity'], ['rps', '300', 'p99', '250ms']);
  assert.deepEqual(a.attrs['tags'], ['data', 'pii']);
  assert.deepEqual(a.timeline[0], { when: '2026-12', attrs: { cpu: ['4'], mem: ['8Gi'] } });
});
