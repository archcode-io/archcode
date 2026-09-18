#!/usr/bin/env node
/**
 * archcode — the notation from the command line.
 *
 *   archcode render <file.arch> [--lens logical|infrastructure] [--theme dark|light] [--kind model|deployment]
 *                               [--phase <name>] [--collapse a,b] [-o out.svg]
 *   archcode check  <file.arch>... [--strict]      exit 1 on errors (--strict: on warnings too)
 *   archcode build  <file.arch> [--yaml] [-o out]   the compiled form, archcode/v1
 *   archcode fmt    <file.arch>                     round-trip check: prints the file back byte for byte
 *
 * Every command reads `-` as stdin and writes to stdout unless -o is given.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, lower, check, applyLens, layout, toSvg, toJSON, toYAML, serialize, THEMES } from '@archcode-io/engine';

const args = process.argv.slice(2);
const cmd = args.shift();
const flags = {}, files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') flags.out = args[++i];
  else if (a.startsWith('--')) { const k = a.slice(2); const v = args[i + 1]; if (v !== undefined && !v.startsWith('-')) { flags[k] = v; i++; } else flags[k] = true; }
  else files.push(a);
}
const read = f => (f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8'));
const emit = (text, def) => { if (flags.out) writeFileSync(flags.out, text); else if (def) process.stdout.write(text); };
const fail = msg => { process.stderr.write(msg + '\n'); process.exit(2); };

const usage = `archcode ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}

  archcode render <file.arch> [--lens logical|infrastructure] [--theme dark|light] [--kind model|deployment]
                              [--phase <name>] [--collapse a,b] [-o out.svg]
  archcode check  <file.arch>... [--strict]
  archcode build  <file.arch> [--yaml] [-o out.json|out.yaml]
  archcode fmt    <file.arch>

Docs: https://archcode.io/docs/ · Quickstart: https://archcode.io/docs/quickstart/`;

function load(f) {
  const src = read(f);
  const { doc, diagnostics } = parse(src);
  const model = lower(doc);
  return { src, doc, model, diagnostics: [...diagnostics, ...check(doc, model)] };
}
const print = (f, ds) => { for (const d of ds) process.stderr.write(`${f}:${d.line}:${d.col} ${d.severity} ${d.code} ${d.message}\n`); };

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(usage + '\n'); process.exit(0); }
if (cmd === '--version' || cmd === '-v') { process.stdout.write(usage.split('\n')[0].split(' ')[1] + '\n'); process.exit(0); }

if (cmd === 'check') {
  if (!files.length) fail('check: give at least one file');
  let errors = 0, warnings = 0;
  for (const f of files) {
    const { diagnostics } = load(f);
    print(f, diagnostics);
    errors += diagnostics.filter(d => d.severity === 'error').length;
    warnings += diagnostics.filter(d => d.severity === 'warning').length;
  }
  process.stderr.write(`${files.length} file${files.length > 1 ? 's' : ''} · ${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}\n`);
  process.exit(errors || (flags.strict && warnings) ? 1 : 0);
}

if (cmd === 'render') {
  const f = files[0]; if (!f) fail('render: give a file');
  const { model, diagnostics } = load(f);
  print(f, diagnostics.filter(d => d.severity !== 'info'));
  const theme = flags.theme === 'light' ? 'light' : 'dark';
  const g = applyLens(model, {
    lens: flags.lens === 'infrastructure' ? 'infrastructure' : 'logical',
    kind: flags.kind === 'deployment' ? 'deployment' : 'model',
    phase: typeof flags.phase === 'string' ? flags.phase : undefined,
    collapsed: typeof flags.collapse === 'string' ? flags.collapse.split(',') : undefined,
  });
  const l = await layout(g);
  const svg = toSvg(l, '', { theme, name: `${f.replace(/^.*\//, '').replace(/\.arch$/, '')} — ${flags.kind ?? 'model'}` })
    .replace(/(<svg[^>]*viewBox="([^"]+)"[^>]*>)/, (m, tag, vb) => { const [x, y, w, h] = vb.split(' '); return `${tag}\n<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${THEMES[theme].bg}"/>`; });
  emit(svg, true);
  process.exit(0);
}

if (cmd === 'build') {
  const f = files[0]; if (!f) fail('build: give a file');
  const { model, diagnostics } = load(f);
  print(f, diagnostics.filter(d => d.severity !== 'info'));
  const version = /^\s*archcode\s+(\S+)/m.exec(read(f))?.[1];
  emit(flags.yaml || /\.ya?ml$/.test(flags.out ?? '') ? toYAML(model, version) : toJSON(model, version), true);
  process.exit(diagnostics.some(d => d.severity === 'error') ? 1 : 0);
}

if (cmd === 'fmt') {
  const f = files[0]; if (!f) fail('fmt: give a file');
  const { src, doc } = load(f);
  const out = serialize(doc);
  if (out !== src) fail('fmt: the tree did not round-trip — please report this file');
  emit(out, true);
  process.exit(0);
}

fail(`unknown command \`${cmd}\`\n\n${usage}`);
