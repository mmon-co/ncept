# Default theory Skill catalog

Markdown is the authoring source for the tutor's Skills, each named for an activity: `mission`, `chart`, `checkpoint`, `publish`, `material` (whose resources are a guide per Session type and a format per Material kind), `records` and `help`. `base.md` holds the always-loaded tutor instruction. Each `<name>/SKILL.md` declares only its `name` and `description`; the tutor loads any Skill listed for its mode. No mode has an automatic procedure; a mode's prompt is `base.md` plus its Skill index.

`bun scripts/build-skills.ts` (`bun run build:skills`) embeds the Markdown in the Git-ignored `sources.ts`, because the Convex bundler cannot import Markdown; setup, dev, check, test and deploy run it first. `../skills.ts` imports that module.

`../skills.ts` returns catalog values. The tutor's index for a mode is a flat list; the learner never starts a Skill. Each Session mode receives only its declared catalog in `chat.open` and `chat.turn`.

The default theory mounts `theory` instruments and Lesson's `evaluation` envelope; their `run` methods are Programs. The host homes approved Chart draft claims, and its internal closing/event/sweep Programs own record refinement; these are not interactive aliases. The host supplies effective evidence and owns persistence/execution. Evaluation writes observations, never learner labels. Claims are homed by content, not Edges. Memory compaction belongs to the closing-span Program and never creates demonstration evidence. Host graph, Confirmation, Material, code and review actions remain host tools, conditional on what is actually mounted.
