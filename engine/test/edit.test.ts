import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retargetRelation, setRelationVerb, setRelationAttr,
  addObject, deleteObject, renameObject, setDisplayName, setAttribute,
  addRelation, deleteRelation, moveInto, moveOut, parse, lower, roundTrips,
} from '../src/index.js';

const SRC = `# shop
service   checkout  "Checkout"  tech Go
datastore orders_db "Orders DB" tech "PostgreSQL 16"

checkout writes orders_db over SQL

view main {
  lens logical
}
`;

const ids = (s: string) => [...lower(parse(s).doc).objects.values()].map(o => o.localId).sort();

test('every edit leaves a document that still round-trips', () => {
  const edits = [
    addObject(SRC, { kind: 'service', id: 'billing', name: 'Billing', attrs: { tech: 'Kotlin' } }),
    deleteObject(SRC, 'orders_db'),
    renameObject(SRC, 'orders_db', 'orders_store'),
    setDisplayName(SRC, 'checkout', 'Checkout API'),
    setAttribute(SRC, 'checkout', 'owner', '@team-sales'),
    addRelation(SRC, 'checkout', 'calls', 'billing', 'HTTPS'),
    deleteRelation(SRC, 'checkout', 'writes', 'orders_db'),
  ];
  for (const e of edits) assert.ok(roundTrips(e), 'edit produced an unparseable document');
});

test('new objects land before the view block, not after it', () => {
  const out = addObject(SRC, { kind: 'service', id: 'billing', name: 'Billing' });
  const lines = out.split('\n');
  assert.ok(lines.findIndex(l => l.startsWith('service   billing') || l.startsWith('service billing'))
          < lines.findIndex(l => l.startsWith('view')), 'declaration must precede the view');
  assert.deepEqual(ids(out), ['billing', 'checkout', 'main', 'orders_db']);
});

test('deleting an object takes its relations with it', () => {
  const out = deleteObject(SRC, 'orders_db');
  assert.deepEqual(ids(out), ['checkout', 'main']);
  assert.equal(lower(parse(out).doc).relations.length, 0, 'no dangling arrow may survive');
});

test('renaming updates the declaration and every reference', () => {
  const out = renameObject(SRC, 'orders_db', 'orders_store');
  assert.ok(out.includes('datastore orders_store'));
  assert.ok(out.includes('checkout writes orders_store'));
  assert.ok(!out.includes('orders_db'));
});

test('renaming does not touch comments or lookalike words', () => {
  const out = renameObject('# orders_db is fine here\nservice orders_db2\nservice orders_db\n', 'orders_db', 'x');
  assert.ok(out.includes('# orders_db is fine here'), 'comments are left alone');
  assert.ok(out.includes('service orders_db2'), 'a longer identifier is not a match');
  assert.ok(out.includes('service x'));
});

test('display name replaces the existing string rather than adding a second', () => {
  const out = setDisplayName(SRC, 'checkout', 'Checkout API');
  assert.equal((out.match(/"/g) ?? []).length, (SRC.match(/"/g) ?? []).length);
  assert.equal(lower(parse(out).doc).objects.get('checkout')!.name, 'Checkout API');
});

test('a name goes after the identifier even when the identifier equals the kind', () => {
  // `datastore datastore` — searching the line for the id finds the kind first,
  // which used to produce `datastore "test" datastore` and an unparseable file.
  const src = 'datastore datastore\n';
  const out = setDisplayName(src, 'datastore', 'test');
  assert.equal(out.trim(), 'datastore datastore "test"');
  assert.ok(roundTrips(out));
  const m = lower(parse(out).doc);
  assert.equal(m.objects.get('datastore')!.name, 'test');
  assert.equal(parse(out).diagnostics.filter(d => d.severity === 'error').length, 0);
});

test('renaming a freshly added object keeps the line well formed', () => {
  let src = addObject('', { kind: 'datastore', id: 'db_1' });
  src = setDisplayName(src, 'db_1', 'Orders');
  src = renameObject(src, 'db_1', 'orders_db');
  assert.equal(src.trim(), 'datastore orders_db "Orders"');
  assert.ok(roundTrips(src));
});

test('attributes are added, updated and removed in place', () => {
  const added = setAttribute(SRC, 'checkout', 'owner', '@team-sales');
  assert.equal(lower(parse(added).doc).objects.get('checkout')!.attrs['owner']?.[0], '@team-sales');
  const updated = setAttribute(added, 'checkout', 'tech', 'Rust');
  assert.equal(lower(parse(updated).doc).objects.get('checkout')!.attrs['tech']?.[0], 'Rust');
  const removed = setAttribute(updated, 'checkout', 'owner', null);
  assert.equal(lower(parse(removed).doc).objects.get('checkout')!.attrs['owner'], undefined);
});

test('moveInto nests a declaration and creates the block when there is none', () => {
  const withSys = 'system shop "Shop"\nservice checkout "Checkout"\n';
  const out = moveInto(withSys, 'checkout', 'shop');
  const m = lower(parse(out).doc);
  assert.ok(m.objects.has('shop.checkout'), 'checkout should now be scoped to shop');
  assert.ok(roundTrips(out));
});

test('relations survive a round-trip and are removed exactly', () => {
  const out = deleteRelation(SRC, 'checkout', 'writes', 'orders_db');
  assert.equal(lower(parse(out).doc).relations.length, 0);
  assert.ok(out.includes('datastore orders_db'), 'the object itself stays');
});


test('a container can be moved into a system and back out again', () => {
  const start = 'system shop "Shop"\nservice checkout "Checkout" tech Go\ndatastore db "DB"\ncheckout writes db\n';
  const inside = moveInto(start, 'checkout', 'shop');
  let m = lower(parse(inside).doc);
  assert.ok(m.objects.has('shop.checkout'), 'checkout is now scoped to shop');
  assert.ok(roundTrips(inside));

  const out = moveOut(inside, 'checkout');
  m = lower(parse(out).doc);
  assert.ok(m.objects.has('checkout'), 'and back at the top level');
  assert.ok(!m.objects.has('shop.checkout'));
  assert.ok(roundTrips(out));
  assert.equal(parse(out).diagnostics.filter(d => d.severity === 'error').length, 0);
});

test('emptying a system leaves no dangling braces', () => {
  const start = 'system shop "Shop" {\n  service checkout "Checkout"\n}\n';
  const out = moveOut(start, 'checkout');
  assert.ok(!/\{\s*\}/.test(out), 'no empty block should survive');
  assert.ok(roundTrips(out));
  assert.equal(parse(out).diagnostics.filter(d => d.severity === 'error').length, 0);
});

test('several containers can be gathered into one new system', () => {
  let src = 'service a "A"\nservice b "B"\na calls b\n';
  src = addObject(src, { kind: 'system', id: 'sys_1', name: 'Grouped' });
  for (const id of ['a', 'b']) src = moveInto(src, id, 'sys_1');
  const m = lower(parse(src).doc);
  assert.ok(m.objects.has('sys_1.a') && m.objects.has('sys_1.b'));
  assert.ok(roundTrips(src));
});

test('setAttribute keeps a comma list a list, and replaces the whole list', () => {
  const src = 'node edge "Edge" {\n  agent antivirus, alloy\n  cpu 8\n}\n';
  const out = setAttribute(src, 'edge', 'agent', 'antivirus, alloy, haproxy');
  assert.equal(out, 'node edge "Edge" {\n  agent antivirus, alloy, haproxy\n  cpu 8\n}\n');
  const m = lower(parse(out).doc);
  assert.deepEqual(m.objects.get('edge')!.attrs['agent'], ['antivirus', 'alloy', 'haproxy']);
  const less = setAttribute(out, 'edge', 'agent', 'haproxy');
  assert.equal(less, 'node edge "Edge" {\n  agent haproxy\n  cpu 8\n}\n');
  const inline = setAttribute('node n cpu 2 agent a, b mem 4Gi\n', 'n', 'agent', 'x, y, z');
  assert.equal(inline, 'node n cpu 2 agent x, y, z mem 4Gi\n');
  assert.equal(setAttribute(inline, 'n', 'agent', null), 'node n cpu 2 mem 4Gi\n');
});

test('retargetRelation moves one end and keeps everything else as written', () => {
  const src = 'service a\nservice b\nservice c\na calls b over HTTPS via gw "label" { timeout 2s }\n';
  assert.equal(retargetRelation(src, 'a', 'calls', 'b', 'to', 'c'), 'service a\nservice b\nservice c\na calls c over HTTPS via gw "label" { timeout 2s }\n');
  assert.equal(retargetRelation(src, 'a', 'calls', 'b', 'from', 'c'), 'service a\nservice b\nservice c\nc calls b over HTTPS via gw "label" { timeout 2s }\n');
  // inside a body the subject is implicit: retargeting the source writes it out
  const body = 'system s {\n  service a {\n    calls b over SQL\n  }\n  service b\n  service c\n}\n';
  assert.equal(retargetRelation(body, 'a', 'calls', 'b', 'to', 'c'), 'system s {\n  service a {\n    calls c over SQL\n  }\n  service b\n  service c\n}\n');
  assert.equal(retargetRelation(body, 'a', 'calls', 'b', 'from', 'c'), 'system s {\n  service a {\n    c calls b over SQL\n  }\n  service b\n  service c\n}\n');
  assert.equal(retargetRelation(src, 'a', 'calls', 'zz', 'to', 'c'), src);
});

test('setRelationVerb swaps only the verb', () => {
  const src = 'service a\nservice b\na calls b over HTTPS "hi"  # c\n';
  assert.equal(setRelationVerb(src, 'a', 'calls', 'b', 'uses'), 'service a\nservice b\na uses b over HTTPS "hi"  # c\n');
  assert.equal(setRelationVerb('system s {\n  service a\n  calls b\n}\nservice b\n', 's', 'calls', 'b', 'reads'), 'system s {\n  service a\n  reads b\n}\nservice b\n');
});

test('setRelationAttr rewrites, appends and removes inline facts', () => {
  const src = 'a calls b over HTTPS via gw, waf "hi" {\n  auth oidc\n}\n';
  assert.equal(setRelationAttr(src, 'a', 'calls', 'b', 'over', 'gRPC'), 'a calls b over gRPC via gw, waf "hi" {\n  auth oidc\n}\n');
  assert.equal(setRelationAttr(src, 'a', 'calls', 'b', 'via', 'gw'), 'a calls b over HTTPS via gw "hi" {\n  auth oidc\n}\n');
  assert.equal(setRelationAttr(src, 'a', 'calls', 'b', 'via', null), 'a calls b over HTTPS "hi" {\n  auth oidc\n}\n');
  assert.equal(setRelationAttr(src, 'a', 'calls', 'b', 'label', 'place order'), 'a calls b over HTTPS via gw, waf "place order" {\n  auth oidc\n}\n');
  assert.equal(setRelationAttr(src, 'a', 'calls', 'b', 'label', null), 'a calls b over HTTPS via gw, waf {\n  auth oidc\n}\n');
  assert.equal(setRelationAttr(src, 'a', 'calls', 'b', 'port', '8443'), 'a calls b over HTTPS via gw, waf "hi" port 8443 {\n  auth oidc\n}\n');
  assert.equal(setRelationAttr('a calls b  # why\n', 'a', 'calls', 'b', 'over', 'SQL'), 'a calls b over SQL  # why\n');
  assert.equal(setRelationAttr('a calls b\n', 'a', 'calls', 'b', 'label', 'a b'), 'a calls b "a b"\n');
  assert.equal(setRelationAttr('a calls b over HTTPS\n', 'a', 'calls', 'b', 'over', null), 'a calls b\n');
});
