# ArchCode for VS Code

`.arch` files — [ArchCode](https://archcode.io), an open notation for software architecture —
with syntax colouring, the engine's diagnostics in the Problems panel, and a **live preview
beside the file**: the same picture the Playground draws, redrawn as you type, with the
lens (Logical / Infrastructure) and the kind (Model / Deployment) switchable in the preview,
and an *Export SVG…* button.

Open the preview from the editor title button, the command palette (*ArchCode: Open Preview
to the Side*) or `⌘K V` — the same key as Markdown's preview.

The engine is bundled (`@archcode-io/engine`, layout included), so nothing else is needed.
The grammar is generated from the engine's vocabulary (`npm run grammar`).

## Install

Download the `.vsix` from [archcode.io/download/vscode](https://archcode.io/download/vscode), then

```sh
code --install-extension archcode-0.2.2.vsix     # or: Extensions view → ⋯ → Install from VSIX…
```

Cursor, Windsurf and VSCodium take the same file (`cursor --install-extension …`).
To build it yourself: `npm install && npm run package`.

Coming: completion of ids, hover with the object's facts, go-to-definition.

Apache-2.0 · ArchCode is an open standard created and maintained by Baryshev Labs.
