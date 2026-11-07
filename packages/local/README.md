# @mmon-co/local

MIT-licensed Profile directory and local host contract. Core owns Patch and log semantics; this package owns their files and the portable exchange tar.

## Directory API

```ts
import { init, openProfile, unpackDirectory } from "@mmon-co/local";
import { defaultTheory } from "@mmon-co/default-theory";

await init("/path/to/learn");
const profile = await openProfile("/path/to/learn", [defaultTheory]);
const reading = await profile.read();
const tar = await profile.pack();
await unpackDirectory(tar, "/path/to/moved-profile", [defaultTheory]);
```

`init` creates an empty personal Patch, empty log and reserved directories in an ordinary project directory. `profile.json` contains `format: 1`, `personal`, `theory` (Core's requirement), `theories` (package names, initially `@mmon-co/default-theory`) and `sessions` (surface → pi filename). Account credentials live at `credentialsPath()`, outside the Profile, in `~/.config/mmon/credentials.json`.

`openProfile` verifies digests, the personal Patch's complete base closure, log envelopes and the configured Theory range. Its handle appends log identities, adds immutable revisions and blobs, changes the personal head, and registers trusted transcripts. Add attachment bytes before revisions referring to them. A new revision replaces its identity's prior content; its bases are other Patches, not its own history.

pi chooses `sessions/<timestamp>_<sessionId>.jsonl`. After project trust, use `registerSession(surface, filename, { trusted: true })` for an existing pi file or `writeSession` for an imported one. Files merely present in `sessions/` do not count: pi can create them before trust. Moving/opening or unpacking rewrites registered session headers' `cwd` so pi's `/resume` can find them; entry and tool-call ids stay unchanged. `parsePiSession`/`serializePiSession` preserve provider metadata and opaque non-message entries alongside the exchange's typed messages.

## Pure exchange

Import `@mmon-co/local/exchange` in Convex actions or browsers; it has no Node imports. `pack(files, theories)`, `unpack(tar, theories, { cwd })` and `validate(files, theories)` use a map of relative paths to bytes and supplied Theory identities. Package names in the manifest are data, not imports. The uncompressed ustar contains only `profile.json`, `log.jsonl`, `patches/`, `blobs/` and registered `sessions/`; the directory adapter leaves working copies in `materials/` and unrelated project files behind. Unsupported tar entry types, unsafe paths and duplicate paths are refused. `unpackDirectory` requires unused reserved directories rather than merging into an existing Profile.

## Host contract

`src/host.ts` defines `openHost({ profileDir, theories, model, confirm })`, session setup and bound tools, mode-switch results, Mission/status readings, Hub and configuration APIs. `openHost` intentionally throws `not implemented`: execution and transport implementations build against this shared contract. The front end supplies constrained JSON model replies for `judge`/`assess`, confirms proposals, and carries out `here`/`next`/`aside` conversation changes.

## First use from this repository

```sh
bun test --parallel packages/local/test
bun run --cwd packages/local build
```

The directory round-trip uses disposable temporary Profiles with a Mission, a blob, a base chain and a pi transcript; it needs neither auth nor a deployment. The corruption encounter refuses changed Patch content, a missing base and malformed log lines with their reasons.
