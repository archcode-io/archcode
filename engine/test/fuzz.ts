/**
 * Round-trip fuzzer (D-27).
 *
 * Generates documents that mix valid statements, hostile whitespace, comments,
 * unicode and truncation, then asserts that `parse → serialize` reproduces the
 * input byte for byte. A single failure prints a minimized counter-example and
 * exits non-zero, which is what blocks a release.
 */
import { parse, serialize } from '../src/index.js';

const COUNT = Number(process.env.FUZZ_COUNT ?? 1000);
const SEED = Number(process.env.FUZZ_SEED ?? 20260908);

/** mulberry32 — deterministic, so a failing run is reproducible from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['service', 'webapp', 'gateway', 'broker', 'datastore', 'cache', 'system', 'external', 'actor', 'topic', 'component', 'job'];
const VERBS = ['calls', 'writes', 'reads', 'publishes', 'subscribes', 'uses', 'streams', 'emits', 'listens', 'depends_on'];
const KEYS = ['tech', 'owner', 'tags', 'criticality', 'retention', 'pii', 'replicas', 'transit', 'stage'];
const VALS = ['Go', 'Kotlin', '"PostgreSQL 16"', '@team-sales', 'high', '400d', 'true', '6', '180ms', '4Gi', '99.9%', 'core', '"кириллица тоже"', 'a.b-c_d'];
const WS = ['', ' ', '  ', '\t', ' \t ', '   \t'];
const COMMENTS = ['# note', '#', '#  трейлинг   ', '# {} , " unbalanced'];

export function generate(seed: number): string {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const ws = () => pick(WS);
  const id = () => `${pick(['a', 'b', 'svc', 'db', 'gw', 'x_1', 'orders', 'order.placed'])}`;

  const lines: string[] = [];
  const n = 1 + Math.floor(r() * 14);

  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.10) { lines.push(ws()); continue; }                       // blank
    if (roll < 0.20) { lines.push(ws() + pick(COMMENTS)); continue; }      // comment only

    if (roll < 0.55) {                                                      // declaration
      let l = ws() + pick(KINDS) + ws() + ' ' + id();
      if (r() < 0.6) l += ws() + ' "' + pick(['Имя', 'Name', 'a b  c', '']) + '"';
      const attrs = Math.floor(r() * 3);
      for (let k = 0; k < attrs; k++) l += ws() + ' ' + pick(KEYS) + ws() + ' ' + pick(VALS);
      if (r() < 0.25) {                                                     // with a body
        lines.push(l + ws() + ' {');
        const inner = Math.floor(r() * 4);
        for (let k = 0; k < inner; k++) {
          if (r() < 0.5) lines.push(ws() + '  ' + pick(KEYS) + ' ' + pick(VALS));
          else lines.push(ws() + '  ' + pick(VERBS) + ' ' + id() + (r() < 0.4 ? ' over ' + pick(['SQL', 'HTTPS', 'AMQP']) : ''));
        }
        lines.push(ws() + '}');
        continue;
      }
      if (r() < 0.3) l += ws() + ' ' + pick(COMMENTS);
      lines.push(l);
      continue;
    }

    // relation
    let l = ws() + id() + ws() + ' ' + pick(VERBS) + ws() + ' ' + id();
    if (r() < 0.4) l += ' over ' + pick(['SQL', 'HTTPS', 'AMQP', 'gRPC']);
    if (r() < 0.3) l += ' via ' + pick(['gw', 'rabbit', 'cdn, waf, gw']);
    if (r() < 0.3) l += ' "' + pick(['метка', 'label with  spaces', '']) + '"';
    if (r() < 0.2) l += ' ' + pick(COMMENTS);
    lines.push(l);
  }

  let src = lines.join(r() < 0.9 ? '\n' : '\r\n');
  if (r() < 0.8) src += '\n';                    // sometimes no trailing newline
  if (r() < 0.08) src = src.slice(0, Math.floor(src.length * r()));  // truncate mid-token
  if (r() < 0.05) src = '﻿' + src;          // BOM
  return src;
}

function shrink(src: string): string {
  let cur = src;
  for (let pass = 0; pass < 200; pass++) {
    const lines = cur.split('\n');
    if (lines.length <= 1) break;
    let reduced = false;
    for (let i = 0; i < lines.length; i++) {
      const cand = lines.filter((_, k) => k !== i).join('\n');
      if (serialize(parse(cand).doc) !== cand) { cur = cand; reduced = true; break; }
    }
    if (!reduced) break;
  }
  return cur;
}

let failures = 0;
for (let i = 0; i < COUNT; i++) {
  const seed = SEED + i;
  const src = generate(seed);
  const out = serialize(parse(src).doc);
  if (out !== src) {
    failures++;
    console.error(`\n✕ round-trip broke · seed ${seed}`);
    console.error('--- minimized input ---');
    console.error(JSON.stringify(shrink(src)));
    console.error('--- got ---');
    console.error(JSON.stringify(serialize(parse(shrink(src)).doc)));
    if (failures >= 3) break;
  }
}

if (failures) {
  console.error(`\n${failures} round-trip failure(s) out of ${COUNT}`);
  process.exit(1);
}
console.log(`✓ round-trip holds on ${COUNT} generated documents (seed ${SEED})`);
