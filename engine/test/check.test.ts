import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, lower, check } from '../src/index.js';

const codes = (src: string) => { const { doc } = parse(src); return check(doc, lower(doc)).map(d => `${d.code}@${d.line}`); };

test('duplicate ids are errors, once per repeat (AC100)', () => {
  assert.deepEqual(codes('service a\nservice b\nservice a\n'), ['AC100@3']);
  assert.deepEqual(codes('system s {\n  service a\n  service a\n}\nservice a\n'), ['AC100@3']);   // s.a twice; top-level a is another id
});

test('unresolved and ambiguous references (AC101, AC102)', () => {
  assert.deepEqual(codes('service a\na calls b\n'), ['AC101@2']);
  assert.deepEqual(codes('system x { service db }\nsystem y { service db }\nservice a\na writes db\n'), ['AC102@4']);
  assert.deepEqual(codes('system x { service db }\nservice a\na writes db\n'), []);                 // one candidate by suffix is fine
  assert.deepEqual(codes('service a\na calls b via gw\nservice b\n'), ['AC101@2']);
  assert.deepEqual(codes('service a\ndatastore d owned_by nobody\n'), ['AC101@2']);
  assert.deepEqual(codes('topic t { via mq  publisher a  subscriber b }\nservice a\n'), ['AC101@1', 'AC101@1']);
  assert.deepEqual(codes('calls b\nservice b\n'), ['AC101@1']);
});

test('reserved blocks are kept and noted, their bodies are not read (AC103)', () => {
  const src = 'service pay\nrule r { forbid writes pay from * except pay }\ndecision d "x" { status accepted }\n';
  const { doc, diagnostics } = parse(src);
  assert.deepEqual(diagnostics, []);
  const m = lower(doc);
  assert.deepEqual([...m.objects.keys()], ['pay', 'r', 'd']);
  assert.equal(m.relations.length, 0);
  assert.deepEqual(check(doc, m).map(d => d.code + d.severity), ['AC103info', 'AC103info']);
});

test('a view body makes no phantom objects', () => {
  const m = lower(parse('service a\nview v "V" {\n  kind deployment\n  env prod\n  path a → b\n}\n').doc);
  assert.deepEqual([...m.objects.keys()], ['a', 'v']);
});

test('unknown attributes are info, x- keys are silent (AC104)', () => {
  assert.deepEqual(codes('service a foo 1\n'), ['AC104@1']);
  assert.deepEqual(codes('service a x-foo 1\n'), []);
  assert.deepEqual(codes('service a { capacity rps 300 p99 250ms }\n'), []);
});

test('the archcode pragma (AC105)', () => {
  assert.deepEqual(codes('archcode 0.2\nservice a\n'), []);
  assert.deepEqual(codes('archcode 0.9\nservice a\n'), ['AC105@1']);
  assert.deepEqual(codes('service a\narchcode 0.2\n'), ['AC105@2']);
});

test('at without a moment, run in the wrong place, run of the unrunnable (AC106, AC108, AC109)', () => {
  assert.deepEqual(codes('service a { at cpu 2 }\n'), ['AC106@1']);
  assert.deepEqual(codes('service a\nsystem s { run a }\n'), ['AC108@2']);
  assert.deepEqual(codes('actor u\nenv p { run u }\n'), ['AC109@2']);
  assert.deepEqual(codes('service a\nenv p { run a }\n'), []);
});

test('a relation between placement blocks is a mistake (AC107)', () => {
  assert.deepEqual(codes('env p {\n  node n1\n  cluster c1\n}\np.n1 calls p.c1\n'), ['AC107@5']);
});
