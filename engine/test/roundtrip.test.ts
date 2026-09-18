import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, serialize, lower, roundTrips } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test', 'fixtures');
const read = (f: string) => readFileSync(join(fixtures, f), 'utf8');

test('every fixture round-trips byte for byte', () => {
  for (const f of readdirSync(fixtures).filter(f => f.endsWith('.arch'))) {
    const src = read(f);
    assert.equal(serialize(parse(src).doc), src, `round-trip broke on ${f}`);
  }
});

test('minimal document lowers to two objects and one relation', () => {
  const { doc } = parse(read('minimal.arch'));
  const m = lower(doc);
  assert.equal(m.objects.size, 2);
  assert.deepEqual([...m.objects.keys()].sort(), ['checkout', 'orders_db']);
  assert.equal(m.objects.get('checkout')!.kind, 'service');
  assert.equal(m.objects.get('checkout')!.name, 'Checkout');
  assert.equal(m.relations.length, 1);
  assert.deepEqual(m.relations[0], {
    from: 'checkout', to: 'orders_db', verb: 'writes', over: 'SQL',
    via: undefined, spec: undefined, as: undefined, port: undefined, label: undefined, attrs: {}, line: 4,
  });
});

test('identifiers nest under their enclosing object (D-48)', () => {
  const m = lower(parse(read('shop.arch')).doc);
  assert.ok(m.objects.has('shop.orders'), 'orders should be scoped to shop');
  assert.ok(m.objects.has('shop.orders_db'));
  assert.equal(m.objects.get('shop.orders')!.parent, 'shop');
});

test('subject is implied inside an object body (spec §3.3)', () => {
  const m = lower(parse(read('shop.arch')).doc);
  const r = m.relations.find(r => r.to === 'orders_db' && r.verb === 'writes');
  assert.ok(r, 'writes relation should exist');
  assert.equal(r!.from, 'shop.orders', 'subject defaults to the enclosing object');
});

test('via carries a chain in traffic order (D-135)', () => {
  const m = lower(parse(read('edges.arch')).doc);
  const r = m.relations.find(r => r.from === 'spaced');
  assert.deepEqual(r!.via, ['cdn', 'waf', 'gw']);
  assert.equal(r!.label, 'долгий путь');
  assert.equal(r!.over, 'HTTPS');
});

test('emits and listens are sugar for publishes and subscribes (spec §4.2)', () => {
  const m = lower(parse('service a\na emits x\na listens y\n').doc);
  assert.equal(m.relations[0]!.verb, 'publishes');
  assert.equal(m.relations[1]!.verb, 'subscribes');
});

test('exposes / stores are interfaces of the object, not relations (spec §4.3)', () => {
  const m = lower(parse(read('shop.arch')).doc);
  assert.equal(m.relations.some(r => (r.verb as string) === 'exposes'), false);
  const [f] = m.objects.get('shop.orders')!.interfaces;
  assert.deepEqual([f!.verb, f!.kind, f!.pointer, f!.rev], ['exposes', 'http', 'openapi://orders.yaml', 'a1b2c3d']);

  const src = [
    'service checkout {',
    '  exposes http  openapi://checkout.yaml @9f3c2e1',
    '  exposes cli',
    '  exposes grpc proto://checkout.proto "internal" { since 2025-01 }',
    '}',
    'datastore pdb { stores schema sql://payments.dbml @0142 }',
    'checkout exposes graphql sdl://api.graphql',
    '',
  ].join('\n');
  const { doc, diagnostics } = parse(src);
  assert.deepEqual(diagnostics, []);
  assert.equal(serialize(doc), src);
  const m2 = lower(doc);
  const c = m2.objects.get('checkout')!.interfaces;
  assert.deepEqual(c.map(f => [f.kind, f.pointer ?? null, f.rev ?? null]), [
    ['http', 'openapi://checkout.yaml', '9f3c2e1'], ['cli', null, null], ['grpc', 'proto://checkout.proto', null], ['graphql', 'sdl://api.graphql', null],
  ]);
  assert.equal(c[2]!.label, 'internal');
  assert.deepEqual(c[2]!.attrs, { since: ['2025-01'] });
  const s = m2.objects.get('pdb')!.interfaces[0]!;
  assert.deepEqual([s.verb, s.kind, s.pointer, s.rev], ['stores', 'schema', 'sql://payments.dbml', '0142']);
  assert.equal(m2.relations.length, 0);
});

test('a broken file still yields a model (D-58)', () => {
  const src = 'service\nservice ok "fine"\nok calls\n';
  const { doc, diagnostics } = parse(src);
  assert.ok(diagnostics.some(d => d.severity === 'error'), 'errors are reported');
  assert.equal(serialize(doc), src, 'broken input still round-trips');
  const m = lower(doc);
  assert.ok(m.objects.has('ok'), 'the valid part is still modelled');
});

test('roundTrips() helper agrees with the fixtures', () => {
  for (const f of readdirSync(fixtures).filter(f => f.endsWith('.arch'))) {
    assert.ok(roundTrips(read(f)), `${f} should round-trip`);
  }
});
