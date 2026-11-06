# Default theory Skill catalog

Markdown is the authoring source for the tutor's Skills: pedagogy only. They name no Application tool, surface or control, so the same Skills teach on any host; each host supplies its own mechanics as Skills of its own (the web's are in `packages/web/host-skills/`). The activities are `mission`, `chart`, `checkpoint`, `publish`, `material` (whose resources are a guide per Session type) and `records`. `base.md` holds the always-loaded tutor instruction. Each `<name>/SKILL.md` declares only its `name` and `description`; a mode's prompt is `base.md` plus its Skill index.

`bun scripts/build-skills.ts` (`bun run build:skills`) embeds the Markdown in the Git-ignored `sources.ts` (and the web's in `host_skills_sources.ts`), because the Convex bundler cannot import Markdown; setup, dev, check, test and deploy run it first.

The default theory mounts `theory` instruments and Lesson's `evaluation` envelope; their `run` methods are Programs. Evaluation writes observations, never learner labels. Memory compaction belongs to the closing-span Program and never creates demonstration evidence.
