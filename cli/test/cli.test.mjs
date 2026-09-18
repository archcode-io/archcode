import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const bin = new URL('../bin/archcode.mjs', import.meta.url).pathname;
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'archcode-'));
const good = join(dir, 'good.arch'), bad = join(dir, 'bad.arch');
writeFileSync(good, 'service a "A" tech Go\ndatastore d "D"\na writes d over SQL\n');
writeFileSync(bad, 'service a "A"\na calls nobody\nservice a "again"\n');

test('render writes an SVG in the asked theme', () => {
  const r = run('render', good, '--theme', 'light');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^<svg /); assert.match(r.stdout, /fill="#FFFFFF"/); assert.match(r.stdout, /Orders|A/);
  const out = join(dir, 'x.svg'); run('render', good, '-o', out); assert.match(readFileSync(out, 'utf8'), /<svg/);
});
test('check reports diagnostics in file:line:col form and exits 1 on errors', () => {
  const r = run('check', bad);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bad\.arch:2:1 warning AC101/); assert.match(r.stderr, /bad\.arch:3:1 error AC100/);
  assert.equal(run('check', good).status, 0);
  assert.equal(run('check', good, '--strict').status, 0);
});
test('build emits the compiled form, JSON or YAML', () => {
  const j = JSON.parse(run('build', good).stdout);
  assert.equal(j.archcode, '0.2'); assert.equal(j.objects.length, 2); assert.equal(j.relations[0].over, 'SQL');
  assert.match(run('build', good, '--yaml').stdout, /^archcode: "0\.2"\nobjects:/);
});
test('fmt gives the file back byte for byte', () => {
  assert.equal(run('fmt', good).stdout, readFileSync(good, 'utf8'));
});
test('help and an unknown command', () => {
  assert.match(run('--help').stdout, /archcode render/);
  assert.equal(run('nope').status, 2);
});
