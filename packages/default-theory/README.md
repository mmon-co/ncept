# Default Theory

`@mmon-co/default-theory` implements Core's `Theory` interface. It depends on `@mmon-co/core` through public exports, just as a third-party Theory does; Core does not depend on it. The web Application selects it explicitly. FSRS retention, acquisition, Mission futures, tutor Programs and pedagogical Skills live here. Hosts supply persistence, model calls and their own mechanics.

## Use

Import `defaultTheory` and `DEFAULT_THEORY_REQUIREMENT` from `@mmon-co/default-theory`. The executable keeps its identity `default`, version `1.0.0+<commit>` (`dev` outside a deploy) and new-Profile range `~1.0`. This package move changes neither stored observations nor Profile requirements and needs no data migration.

The root exports the implementation's public operations and types. Focused exports are `@mmon-co/default-theory/path`, `/state`, `/messages` and `/outcomes`.

Node.js 20.19+ is supported. Published exports are ESM JavaScript with TypeScript declarations. Install with `npm install @mmon-co/default-theory`; no TypeScript runtime or host assets are needed.

From the repository root, install workspace dependencies with `bun install --frozen-lockfile`, then build and try the package:

```sh
bun run --cwd packages/default-theory build
cd packages/default-theory
node --input-type=module -e 'import { defaultTheory, DEFAULT_THEORY_REQUIREMENT, skillBody } from "@mmon-co/default-theory"; import { resolveTheory } from "@mmon-co/core/theory"; console.log(resolveTheory(DEFAULT_THEORY_REQUIREMENT, [defaultTheory]).version); console.log(skillBody("mission"));'
```

The Skills' Markdown is the source. `build-skills.ts` embeds it in Git-ignored `src/skills/sources.ts`; the build compiles that into JavaScript with the rest of the package. The repository's `build:skills` task uses the same generator for the Convex bundler. Workspace tsconfig paths resolve imports to source. Existing algorithm tests live in `test/`: `bun test --parallel packages/default-theory/test`.

`npm pack --dry-run` from this directory runs `prepack`, rebuilding Core and this package. The archive contains only `dist/`, this README, `LICENSE` and its manifest. Its Core dependency is a registry semver range, not a workspace-only reference.

MIT licensed; see [LICENSE](LICENSE).

## Stored-output version guard

`bun test packages/default-theory/test/stored-output.test.ts` compares a fixed graph and observation log with `test/snapshots/stored-output.<major>.<minor>.json`. The ordinary test suite and pre-integration gate run it too. It records tag membership on Nodes, Edges and the learner at several evidence prefixes and clocks, the `pedagogy:` keys those operations read, and observation payloads emitted by recording tools and outcome/day events. It does not record captions, rankings, readings, paths, prompts or build metadata. Like any fixture, it detects changes exercised by that graph and log, not every possible policy change.

A mismatch requires a minor (mechanical migration) or major (non-mechanical migration) bump to `DEFAULT_THEORY_REF` and the corresponding forward data migration. Changed criteria for applying the same tags count as stored-data changes, not patches. Generate the new version's snapshot after making that change. If the diff changes no stored data, refresh the existing snapshot instead:

```sh
UPDATE_DEFAULT_THEORY_STORED_OUTPUT=1 bun test packages/default-theory/test/stored-output.test.ts
```

Review the snapshot diff; refreshing it is not a substitute for a required version bump or migration. A missing versioned snapshot fails rather than being created by an ordinary test run.

## Observation contract

The observation vocabulary is this package's public data contract, not a Core vocabulary or a private implementation detail. Other Theories may import and interpret it so switching Theory need not restart a learner's progress. They decide how that evidence affects their own state; reusing the evidence does not require reproducing this Theory's labels or FSRS schedules.

Core's `Observation` envelope carries identity, time, scope, support and the producing Theory's exact version. Its payload remains opaque to Core. The exported payload types and guards define what this Theory recognizes:

| Payload | Public type and guard from `@mmon-co/default-theory/outcomes` | Captured evidence |
| --- | --- | --- |
| `completion` | `CompletionOutcome`, `isCompletionOutcome` | Playground and scope, exact Node provenance, complete/incomplete and optional validity boundary |
| `recall` | `RecallOutcome`, `isRecallOutcome` | Card content and Nodes at retrieval, learner answer and recall grade |
| `quiz` | `QuizOutcome`, `isQuizOutcome` | Questions, choices and correct answers, selected/skipped responses and comments |
| `attempt` | `AttemptOutcome`, `isAttemptOutcome` | Problem and grading contract at opening, response, assessment, help and exact revision |

`practiceAttempts` and `problemAttempts` derive per-Node `Demonstration` evidence from captured practice payloads without consulting today's editable Materials. `NodeRef` is `{ node, provenance }`, where `provenance` is the exact authoring Patch revision (`{ identity, digest }`). Captured values are historical evidence, not pointers that a later content edit can reinterpret silently.

Record payload types are exported from `@mmon-co/default-theory/state` and the root as the `DefaultPayload` union. Their `kind` discriminates the following vocabulary:

| Kind | Type | Recorded meaning |
| --- | --- | --- |
| `completion` | `CompletionOutcome` | Scoped complete/incomplete evidence, as above |
| `demonstration` | `Demonstration` | A Node's success/failure/don't-know, whether unaided, grader, task and response; optional evaluation records criterion probabilities and overrides. `recording: "retrieval-opener"` marks lesson-opening retrieval. |
| `lapse` | `Lapse` | Diagnosed regression for a Node, optionally linked to the same lesson's prior slip; affects retention, not acquisition |
| `grade` | `Grade` | A Node's whole-day retention judgment (`Again`, `Hard`, `Good`, `Easy`) and the exact learner-day interval |
| `review-pass` | `ReviewPass` | A passed Review for a Node, clearing the path until its covering grade sets retention |
| `feature-use` | `FeatureUse` | An accepted operation name, not proof of every criterion clause |
| `teaching` | `Teaching` | An explicit explanation taught for a Node, separate from competence evidence |
| `claim` | `Claim` | A statement, optional eliciting prompt and learner stance (`knows`, `forgotten`, `unfamiliar`) |
| `retraction` | `Retraction` | Withdraws the observation named by `of` |
| `homing` | `Homing` | Places the demonstration/claim named by `of` on `homes` Nodes at an exact `revision`; optional `pending` marks unresolved placement |
| `memory` | `Memory` | Speaker-labelled text entries with timestamps and observation or transcript-span sources |
| `memory-summary` | `MemorySummaryPayload` | Retrieval summary text, Material speakers, source observation ids and all consumed dependencies |
| `interpretation` | `Interpretation` | Supported retrieval prose and canonical tags; scope/support are the envelope's `nodes`/`cites`, not learner-state evidence |

Public guards include `isDemonstration`, `isRetrievalOpenerDemonstration`, `isLapse`, `isGrade`, `isReviewPass`, `isFeatureUse`, `isTeaching`, `isClaim`, `isRetraction`, `isHoming` and `isMemory`. `isDefaultObservation` checks producing-Theory attribution only; it is not a payload validator. `MemorySummaryPayload` and `Interpretation` have exported types but no standalone public guards. Other Theories choose which kinds they understand and preserve unread observations when exchanging a Profile.

Observation-contract changes follow the Theory's semver and forward-migration rules: a patch needs no dependent-data migration, a minor permits a mechanical migration, and a major requires a non-mechanical one. This extraction preserves the existing payloads and validators unchanged.
