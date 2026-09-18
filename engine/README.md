# ArchCode engine

The reference implementation of [ArchCode](https://archcode.io) — an open notation for
describing the architecture of digital systems across C4 levels. Compact enough to paste
into a README, precise enough to validate, diff and generate from code.

```archcode
service   checkout   "Checkout"      tech Go
datastore orders_db  "Orders DB"     tech PostgreSQL 16

checkout writes orders_db over SQL
```

This package turns text like that into a model, a picture, and data — and back into the
same text, byte for byte.

**Status: v0.2 preview.** The language is a draft; the API below is what the Playground at
[archcode.io/play](https://archcode.io/play/) runs on and will change before 1.0.

## What is inside

| module | what it does |
|---|---|
| `parse` / `serialize` | text ⇄ lossless syntax tree — comments, spacing and order survive a round trip, and the fuzzer checks that on every build |
| `lower` | syntax tree → model: objects with full ids, relations, interfaces, placements, timelines |
| `check` | semantic diagnostics `AC100…AC109` — unknown references, ambiguous ids, attributes out of scope |
| `applyLens` | the model as a graph for one lens (`logical`, `infrastructure`), one phase, one moment |
| `layout` | positions and orthogonal routes (ELK, two-phase); `repairRoute` keeps a person's arrows when cards move |
| `toSvg` | the picture, dark or light theme |
| `toCompiled` / `toJSON` / `toYAML` | the model as plain data (schema `archcode/v1`) |
| `capacityTable` | resources per environment and moment, from `run … cpu 4 mem 8Gi` |
| `addObject`, `setAttribute`, `retargetRelation`, … | edits that touch only the line they mean |

## Use

```sh
npm install        # once
npm run build      # tsc → dist/
npm test           # unit tests
npm run fuzz       # random documents through parse → serialize, must be identical
```

```ts
import { parse, lower, check, applyLens, layout, toSvg } from './dist/src/index.js';

const src = `service a "A"\nservice b "B"\na calls b over HTTPS`;
const { doc, diagnostics } = parse(src);
const model = lower(doc);
diagnostics.push(...check(doc, model));

const graph = applyLens(model, { lens: 'logical' });
const positioned = await layout(graph);
const svg = toSvg(positioned, '', { theme: 'light' });
```

The engine has no opinion about where ELK runs. In Node it loads the bundled ELK on first
use; a browser host calls `useElkWorker('/elk-worker.js')` once and every layout after that
runs in a Web Worker.

On npm as a preview: `npm install @archcode-io/engine@preview` (prereleases sit under the `preview` tag, not `latest`).

## Layout of the repository

```
src/          lexer · parser · cst · model · check · compiled · edit · lens · capacity
src/layout/   elk (layered) · balance (two-phase) · route (A*) · ortho · label · host
src/render/   svg
test/         unit tests, fixtures, fuzz.ts
tools/        layout scoring and strategy experiments
```

## The language

The specification lives at [archcode.io/docs](https://archcode.io/docs/). Marks in the
text say what this engine implements, what is partial, and what is reserved for v0.3.

## Contributing

ArchCode is at an early stage and we are not taking pull requests yet — see
[CONTRIBUTING](https://github.com/archcode-io/.github/blob/main/CONTRIBUTING.md) for what
we do welcome, and for the DCO sign-off that every commit carries.

## License

Apache-2.0 — see [LICENSE](LICENSE). The ArchCode language and its specification are a
separate work under CC BY 4.0.

ArchCode is an open standard created and maintained by Baryshev Labs.
