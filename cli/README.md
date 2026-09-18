# archcode

The [ArchCode](https://archcode.io) command line — render an `.arch` file to SVG, check it,
build the compiled form.

```sh
npm i -g archcode@preview

archcode render archcode.arch -o architecture.svg          # dark; --theme light for a page
archcode render archcode.arch --lens infrastructure --kind deployment -o deploy.svg
archcode check  src/**/*.arch                              # exit 1 on errors, --strict on warnings
archcode build  archcode.arch -o arch.json                 # or -o arch.yaml
archcode fmt    archcode.arch                              # the file back, byte for byte (a round-trip check)
```

Every command reads `-` for stdin and writes to stdout without `-o`. Diagnostics go to
stderr as `file:line:col severity CODE message`, the shape editors and CI understand.

The engine behind it is [`@archcode-io/engine`](https://www.npmjs.com/package/@archcode-io/engine);
the language is at [archcode.io/docs](https://archcode.io/docs/).

**Status: 0.2 preview.** Apache-2.0. ArchCode is an open standard created and maintained by Baryshev Labs.
