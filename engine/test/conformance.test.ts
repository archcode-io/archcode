/**
 * The spec's conformance suite, run against this engine. The fixtures live in
 * the spec repository; checked out beside this one that is ../archcode-spec, elsewhere
 * point CONFORMANCE at a checkout. Without either the test is skipped, not failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const suite = process.env.CONFORMANCE ?? join(here, '..', '..', '..', '..', 'archcode-spec', 'conformance');
const engine = join(here, '..', 'src', 'index.js');

test('spec conformance suite', { skip: !existsSync(join(suite, 'run.mjs')) && 'spec/conformance not found' }, () => {
  const r = spawnSync(process.execPath, [join(suite, 'run.mjs'), '--engine', engine, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.split('\n').filter(l => /FAIL|problems|expected/.test(l)).join('\n') || r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.failed, 0);
  assert.ok(out.passed >= 40, `only ${out.passed} fixtures`);
});
