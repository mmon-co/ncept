# Core

`@mmon-co/core` owns the portable data and algorithms shared by mmon hosts:

- **Patches**: content-addressed revisions, Nodes, Edges, Materials, metadata, composition, release resolution and validation. Revision digests identify immutable content.
- **The observation log and Profile**: observation envelopes with opaque Theory payloads, portable Mission/run records, log merging and closed Patch bundles. Core validates structure, not the pedagogical meaning of evidence.
- **The Theory interface**: version/range resolution, state folds, projections, Session modes and Programs. A Program yields reads, writes and judgments for a host to execute; Core does not call a model.

Hosts own storage, attachment bytes, authentication, Hub transport, scheduling, model calls, tool execution and UI. Theories own learner-state interpretation, pedagogy and Skills. The default implementation is the separate `@mmon-co/default-theory` package; Core does not depend on it.

## Use

```sh
npm install @mmon-co/core
```

```js
import { emptyPatch, contentDigest } from "@mmon-co/core";

console.log(contentDigest(emptyPatch()));
```

The root exports the public operations and types. Focused exports are `/digest`, `/patch`, `/observations`, `/profile`, `/theory`, `/theory/path` and `/theory/speaker`. Node.js 20.19+ is supported. Published exports are ESM JavaScript with TypeScript declarations, usable without a TypeScript runtime.

## Build in the source repository

```sh
bun install --frozen-lockfile
bun run --cwd packages/core build
cd packages/core
npm pack --dry-run
```

`prepack` rebuilds `dist/`. The package contains only `dist/`, this README, `LICENSE` and its manifest. Repository tsconfig paths resolve workspace imports directly to source; they are not aliases for any former package name.

MIT licensed; see [LICENSE](LICENSE).
