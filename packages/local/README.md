# @mmon-co/local

MIT-licensed Profile directory and learning host. Core owns Patch and log semantics; this package owns their files and the portable exchange tar.

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

`openHost({ profileDir, theories, model, confirm })` runs the selected Theory over the directory. The front end supplies constrained JSON replies for `judge` and `assess` (including decision grading), confirms proposals, and carries out the conversation/carry in a returned mode switch. Native catalog members are mounted by their original names; the web's envelopes remain unchanged. `web` and `bash` are the front end's capabilities, not tools implemented here. Hub methods are connected by the separate transport implementation.

Open a Session with `host.sessions.open({ mode, entry })`, then call `.turn(session, {})` for its prompt, context, Skills and bound tools. The default Theory's modes are `empty`, `charting` (entries `goal`, `mission`, `target`, `checkpoint`), `authoring` and `lesson` (entries `lesson`, `review`); the turn's `context` lists each mode's entry kinds and allowed switches. A tool is `{ name, description, schema, run(input) }`:

```ts
const session = await host.sessions.open({ mode: "charting", entry: { kind: "goal", text: "Learn addition" } });
const setup = await host.sessions.turn(session, {});
const claim = setup.tools.find((tool) => tool.name === "record_claim")!;
await claim.run({ statement: "I can add one and one", stance: "knows" });
await host.sessions.close(session);
```

After a switch result, call `.open(result.switch)` for `next`/`aside`; for `here`, keep the same Session handle and request a fresh turn. `.close(session)` records its closing transcript through the Theory. Resume a closed Session with `.open({ mode, resume: session.id })`. Session identities, mode, scope, acceptance provenance and learner-day receipts are platform observations in `log.jsonl`, so they travel with the Profile.

The front end writes pi transcripts and registers their filenames against `session.surface` after trust. `turn(session, { learnerMessage })` takes the selected learner **message entry id**, not message text; it runs a declared reply grader before setup. Reads follow the selected pi branch, and locally recorded evidence derives its standing from its acceptance branch. A library caller without a transcript still retains tool-recorded evidence, but has no closing conversation to record.

Graph drafts stay unsaved until a confirmed `propose`. Mission and guidance/graph proposals and preference changes use `confirm`; a refusal changes no Profile files. Materials use the `local` playground, immutable blob bytes and working copies under `materials/<node>/<material>/<filename>`. Opening preserves an existing working copy. Read-back returns both the saved body and current working-copy text. Other playgrounds' Materials remain readable as saved data without claiming a runner.

`host.config.update({ ...await host.config.read(), timezone: "America/New_York" })` configures learner-days. The initial zone is the machine's IANA zone; each learner-day ends at 04:00 local, including across DST. At startup, the host raises `day.ended` once per elapsed day and records its receipt alongside the Theory's writes. No account or background daemon is needed.

## First use from this repository

```sh
bun test --parallel packages/local/test
bun run --cwd packages/local build
```

The directory round-trip uses disposable temporary Profiles with a Mission, a blob, a base chain and a pi transcript; it needs neither auth nor a deployment. The corruption encounter refuses changed Patch content, a missing base and malformed log lines with their reasons.
