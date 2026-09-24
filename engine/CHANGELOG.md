# Changelog

All notable changes to the ArchCode engine. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once 1.0 is out — until then every release may change the API.

## [0.2.0-preview.1]

### Security
- `toSvg` escaped `&`, `<` and `>` but not quotes, and wrote document values (ids, stage, phase, verbs) into quoted attributes: a crafted document — a share link, a file — could close an attribute and add an event handler to the exported SVG. Quotes are escaped now; a test feeds every attribute a `"` and checks the element keeps only its own attributes.

### Added
- `container`, the generic level-2 kind, for a sketch or a Structurizr import: runnable, themed.

### Changed
- A frame lays out top-down unless it comes out a tower; a card whose arrows all leave vertically slides under its port, so a service–store edge is one straight line.
- Publishing or subscribing into a topic draws the broker once, whether `via` is on the topic or on the relation line.

### Fixed
- The `archcode` CLI named the engine by a local path (`file:../engine`) and did not run once installed from npm; it now depends on `@archcode-io/engine` by version, and a release installs it from the registry before it counts as published.

## [0.2.0-preview.0] — 0.2.0-preview

The first public preview. Everything below is new.

### Language (v0.2 draft)

- Objects: `arch system service webapp app component function job datastore cache gateway broker topic actor external`, placement kinds `env segment cluster node managed`; nested blocks give full ids (`orders.worker`).
- Relations as verbs (`calls publishes subscribes reads writes uses streams depends_on emits listens`) with `over`, `via a, b`, `port`, `spec`, `as`, a label and a body.
- Interfaces by pointer: `exposes http openapi://…`, `stores schema sql://…`.
- Attribute lines with lists, pairs (`dc dc1 vlan 3076`), flags (`transit`) and unit tokens (`8Gi`, `24x7`, `2027-01`).
- Placement: `run a, b` inside a host, sizing (`cpu mem disk gpu count nodes`), `phase` and `at <moment>` timelines.
- `view` blocks: pins (`at`, `size`), `route … from side to side label f below via x y`, lenses, `layout`, `agents on|off`.
- Reserved for v0.3, kept byte for byte by the parser: `decision rule board profile contract`, YAML/JSON dialects as input.

### Engine

- Lossless CST with byte-exact round trip; a fuzzer runs random documents through `parse → serialize`.
- Model lowering with interfaces, placements, timelines and ownership.
- Semantic diagnostics `AC100–AC109` (unknown reference, ambiguous id, attribute out of scope, …).
- Compiled form `archcode/v1`: `toCompiled`, `toJSON`, `toYAML`.
- Lenses (`logical`, `infrastructure`), transit nodes, agents on hosts, phases and moments.
- Two-phase ELK layout, A* orthogonal router, route repair (`repairRoute`) that keeps a person's arrows when cards move, label placement on either side of the line.
- ELK host abstraction: bundled in Node, `useElkWorker(url)` in the browser.
- SVG renderer with dark and light themes; capacity tables.
- Source edits that touch only the line they mean: `addObject`, `renameObject`, `setAttribute`, `retargetRelation`, `moveInto`, `addRun`, …
