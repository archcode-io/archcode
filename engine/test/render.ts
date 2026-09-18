import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, lower, applyLens, layout, toSvg, type Lens } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, '..', '..', 'test', 'fixtures');
const out = join(here, '..', '..', 'out');
mkdirSync(out, { recursive: true });

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['nimbus', 'shop'];

for (const f of files) {
  const m = lower(parse(readFileSync(join(fx, `${f}.arch`), 'utf8')).doc);
  for (const lens of ['logical', 'infrastructure'] as Lens[]) {
    const g = applyLens(m, lens);
    const l = await layout(g);
    writeFileSync(join(out, `${f}-${lens}.svg`), toSvg(l, `${f} · lens ${lens}`));
    console.log(`${f}-${lens}.svg  ${g.roots.length} roots · ${g.edges.length} edges · ${Math.round(l.width)}×${Math.round(l.height)}`);
  }
}
