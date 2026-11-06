# Default Theory

`@concept/default-theory` implements Core's `Theory` interface. It depends on `@concept/core` through public exports, just as a third-party Theory does; Core does not depend on it. The web Application selects it explicitly. FSRS retention, acquisition, Mission futures, tutor Programs and pedagogical Skills live here. Hosts supply persistence, model calls and their own mechanics.

## Use

Import `defaultTheory` and `DEFAULT_THEORY_REQUIREMENT` from `@concept/default-theory`. The executable keeps its identity `default`, version `1.0.0+<commit>` (`dev` outside a deploy) and new-Profile range `~1.0`. This package move changes neither stored observations nor Profile requirements and needs no data migration.

The root exports the implementation's public operations and types. Focused exports are `@concept/default-theory/path`, `/state`, `/messages` and `/outcomes`.

From the repository root, install workspace dependencies with `bun install --frozen-lockfile`, then run:

```sh
bun run build:skills
cd packages/default-theory
bun -e 'import { defaultTheory, DEFAULT_THEORY_REQUIREMENT, skillBody } from "@concept/default-theory"; import { resolveTheory } from "@concept/core/theory"; console.log(resolveTheory(DEFAULT_THEORY_REQUIREMENT, [defaultTheory]).version); console.log(skillBody("mission"));'
```

The Skills' Markdown is the source. The repository's `build:skills` task embeds it in Git-ignored `src/skills/sources.ts` for the Convex bundler; setup, dev, checks, tests and deploys build it first. Existing algorithm tests live in `test/`: `bun test --parallel packages/default-theory/test`.

## Observation contract

The observation vocabulary is this package's public data contract, not a Core vocabulary or a private implementation detail. Other Theories may import and interpret it so switching Theory need not restart a learner's progress. They decide how that evidence affects their own state; reusing the evidence does not require reproducing this Theory's labels or FSRS schedules.

Core's `Observation` envelope carries identity, time, scope, support and the producing Theory's exact version. Its payload remains opaque to Core. The exported payload types and guards define what this Theory recognizes:

| Payload | Public type and guard from `@concept/default-theory/outcomes` | Captured evidence |
| --- | --- | --- |
| `completion` | `CompletionOutcome`, `isCompletionOutcome` | Playground and scope, exact Node provenance, complete/incomplete and optional validity boundary |
| `recall` | `RecallOutcome`, `isRecallOutcome` | Card content and Nodes at retrieval, learner answer and recall grade |
| `quiz` | `QuizOutcome`, `isQuizOutcome` | Questions, choices and correct answers, selected/skipped responses and comments |
| `attempt` | `AttemptOutcome`, `isAttemptOutcome` | Problem and grading contract at opening, response, assessment, help and exact revision |

`practiceAttempts` and `problemAttempts` derive per-Node `Demonstration` evidence from those captured practice payloads without consulting today's editable Materials. The additional accepted evidence vocabulary (`Demonstration`, `Claim`, `Teaching`, `Grade`, `Lapse`, `ReviewPass`, memory and retraction/homing payloads) and their guards are exported from `@concept/default-theory/state` and the package root. `NodeRef` pins a Node to its authoring Patch revision. These captured values are historical evidence, not pointers that a later content edit can reinterpret silently.

Observation-contract changes follow the Theory's semver and forward-migration rules: a patch needs no dependent-data migration, a minor permits a mechanical migration, and a major requires a non-mechanical one. This extraction preserves the existing payloads and validators unchanged.
