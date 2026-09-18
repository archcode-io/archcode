import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, lower, toCompiled, toJSON, toYAML } from '../src/index.js';

const SRC = [
  'archcode 0.2',
  'system shop "Shop" owner @team {',
  '  service checkout "Checkout" tech Go, Gin {',
  '    exposes http openapi://checkout.yaml @9f3c2e1',
  '    writes orders_db over SQL port 5432 "orders"',
  '  }',
  '  datastore orders_db "Orders DB" tech "PostgreSQL 16" owned_by checkout',
  '}',
  'env prod {',
  '  node app cpu 4 mem 8Gi { run shop.checkout replicas 2  at 2027-01 replicas 4 }',
  '}',
  '',
].join('\n');

test('the compiled form carries objects, relations, placements with full ids', () => {
  const c = toCompiled(lower(parse(SRC).doc));
  assert.equal(c.archcode, '0.2');
  assert.deepEqual(c.objects.map(o => o.id), ['shop', 'shop.checkout', 'shop.orders_db', 'prod', 'prod.app']);
  const co = c.objects[1]!;
  assert.deepEqual(co.attrs, { tech: ['Go', 'Gin'] });
  assert.deepEqual(co.interfaces, [{ verb: 'exposes', kind: 'http', pointer: 'openapi://checkout.yaml', rev: '9f3c2e1' }]);
  assert.deepEqual(c.relations, [{ from: 'shop.checkout', verb: 'writes', to: 'orders_db', over: 'SQL', port: '5432', label: 'orders' }]);
  assert.deepEqual(c.placements, [{ host: 'prod.app', run: 'shop.checkout', attrs: { replicas: ['2'] }, timeline: [{ at: '2027-01', attrs: { replicas: ['4'] } }] }]);
});

test('JSON is the compiled form, YAML says the same thing', () => {
  const m = lower(parse(SRC).doc);
  assert.deepEqual(JSON.parse(toJSON(m)), toCompiled(m));
  const y = toYAML(m);
  assert.match(y, /^archcode: "0\.2"\nobjects:\n  - id: shop\n    kind: system\n    name: Shop\n    attrs:\n      owner: \["@team"\]/);
  assert.match(y, /  - id: shop\.orders_db\n    kind: datastore\n    name: "Orders DB"\n    parent: shop\n    attrs:\n      tech: \["PostgreSQL 16"\]\n      owned_by: \[checkout\]/);
  assert.match(y, /mem: \[8Gi\]/);
  assert.match(y, /relations:\n  - from: shop\.checkout\n    verb: writes\n    to: orders_db\n    over: SQL\n    port: "5432"\n    label: orders/);
  assert.match(y, /placements:\n  - host: prod\.app\n    run: shop\.checkout\n    attrs:\n      replicas: \["2"\]\n    timeline:\n      - at: 2027-01\n        attrs:\n          replicas: \["4"\]/);
});

test('an empty model still compiles', () => {
  const m = lower(parse('').doc);
  assert.deepEqual(toCompiled(m), { archcode: '0.2', objects: [], relations: [], placements: [] });
  assert.equal(toYAML(m), 'archcode: "0.2"\nobjects:\nrelations: []\nplacements: []\n');
});
