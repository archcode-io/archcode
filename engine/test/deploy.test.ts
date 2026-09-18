import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, lower, applyLens, capacityTable, roundTrips } from '../src/index.js';

const SRC = `service ui "UI" tech React
service checkout "Checkout" tech Go
datastore db "DB"
service kvell "Kvell" { phase transit }
service pay "Pay" { phase target }
ui calls checkout over HTTPS
checkout writes db over SQL port 5432
checkout calls kvell { phase transit }
checkout calls pay { phase target }

env prod "PROD" {
  segment kis "KIS" {
    node app "App VMs" count 2 cpu 12 mem 16Gi disk 300Gi {
      run ui, checkout
      at 2026-12 count 3
    }
    node dbs "DB VMs" count 3 cpu 8 mem 12Gi {
      disk system 30Gi data 100Gi
      run db
    }
  }
  cluster okd "OKD" nodes 3 cpu 8 mem 16Gi {
    run pay replicas 4 cpu 0.7/2 mem 800Mi/2Gi { phase target }
  }
}
`;

test('run, at and phase survive the round trip and lower into placements', () => {
  assert.ok(roundTrips(SRC));
  const m = lower(parse(SRC).doc);
  assert.deepEqual(m.placements.map(p => `${p.host}:${p.ref}`), ['prod.kis.app:ui', 'prod.kis.app:checkout', 'prod.kis.dbs:db', 'prod.okd:pay']);
  assert.deepEqual(m.objects.get('prod.kis.app')!.timeline, [{ when: '2026-12', attrs: { count: ['3'] } }]);
  assert.deepEqual(m.placements[3]!.attrs, { replicas: ['4'], cpu: ['0.7/2'], mem: ['800Mi/2Gi'], phase: ['target'] });
  assert.equal(m.relations[1]!.port, '5432');
});

test('phase selects one variant; no phase draws everything', () => {
  const m = lower(parse(SRC).doc);
  const ids = (phase?: string) => applyLens(m, { lens: 'logical', phase }).roots.map(n => n.id);
  assert.ok(ids().includes('kvell') && ids().includes('pay'));
  assert.ok(ids('transit').includes('kvell') && !ids('transit').includes('pay'));
  assert.ok(!ids('target').includes('kvell') && ids('target').includes('pay'));
  assert.ok(!ids().includes('prod'));                        // placement is not on the model picture
});

test('the deployment picture nests env → segment → node → cards and keeps relations', () => {
  const g = applyLens(lower(parse(SRC).doc), { lens: 'logical', kind: 'deployment' });
  const flat: string[] = [];
  const walk = (ns: typeof g.roots) => ns.forEach(n => { flat.push(n.id); walk(n.children); });
  walk(g.roots);
  assert.deepEqual(flat, ['prod', 'prod.kis', 'prod.kis.app', 'prod.kis.app/ui', 'prod.kis.app/checkout',
    'prod.kis.dbs', 'prod.kis.dbs/db', 'prod.okd', 'prod.okd/pay']);
  assert.ok(g.edges.some(e => e.from === 'prod.kis.app/checkout' && e.to === 'prod.kis.dbs/db' && e.label === 'SQL :5432'));
});

test('the resources table sums nodes per environment and per moment', () => {
  const t = capacityTable(lower(parse(SRC).doc));
  assert.deepEqual(t.moments, ['now', '2026-12']);
  const prod = t.envs.find(e => e.id === 'prod')!;
  assert.equal(prod.totals['now']!.cpu, 24 + 24 + 24);     // app ×2·12, dbs ×3·8, okd ×3·8
  assert.equal(prod.totals['2026-12']!.cpu, 36 + 24 + 24); // app grows to ×3
  assert.equal(prod.totals['now']!.disk, 600 + 390);
  const pay = prod.rows.find(r => r.id === 'prod.okd/pay')!;
  assert.equal(pay.counted, false);                         // pods inside a sized cluster are demand, not capacity
  assert.equal(pay.figures['now']!.cpu, 8);                 // limit 2 × 4 replicas
});

test('one-line host body: a run takes its sizing, the rest belongs to the host', () => {
  const m = lower(parse('service s3\nenv prod {\n  node store "Storage VM" cpu 4 { run s3 replicas 2 cpu 1  agent restic, alloy }\n}\n').doc);
  const host = m.objects.get('prod.store')!;
  assert.deepEqual(host.attrs['agent'], ['restic', 'alloy']);
  const p = m.placements.find(x => x.host === 'prod.store')!;
  assert.equal(p.attrs['cpu']?.[0], '1');
  assert.equal(p.attrs['replicas']?.[0], '2');
  assert.equal('agent' in p.attrs, false);
});
