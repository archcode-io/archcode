# archcode

The reference implementation of [ArchCode](https://archcode.io) — an open notation for
software architecture — and the tools that ride on it.

| folder | what | npm |
|---|---|---|
| [`engine/`](engine/) | parser with byte-exact round trip · model · semantic checks · lenses · layout · SVG | `@archcode-io/engine` |
| [`cli/`](cli/) | `archcode render \| check \| build \| fmt` | `archcode` |
| [`vscode/`](vscode/) | the VS Code extension: a TextMate grammar generated from the engine's vocabulary | Marketplace `archcode-io.archcode` |

```sh
npm ci --prefix engine && npm run build --prefix engine     # the engine first
npm test --prefix engine && npm run fuzz --prefix engine
npm install --prefix cli && npm test --prefix cli            # cli and vscode link ../engine
```

The language itself — the specification, the examples, the conformance suite — is
[`archcode-spec`](https://github.com/archcode-io/archcode-spec). The site and the Playground
are `archcode-site`.

**Status: v0.2 preview.** Apache-2.0 — see [LICENSE](LICENSE). Contributions: see
[CONTRIBUTING](https://github.com/archcode-io/.github/blob/main/CONTRIBUTING.md); every commit
carries a DCO sign-off (`git commit -s`).

ArchCode is an open standard created and maintained by Baryshev Labs.
