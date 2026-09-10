# Pedagogy Skill catalog

The Agent Skills-compatible catalog of tutor prompts (ADR 0012). A Skill is
a thin poison entry: its description states a condition under which one
Facet cannot advance, its body holds the differential against neighboring
poisons and sequences shared procedures. Designs that are not model
instruction (instruments, the spaced-review Playground) live in
`docs/attachments/default-pedagogical-theory.md`; citations for every guideline live in
`docs/attachments/default-theory-evidence.md`.

## Layout

- `base.md`: the base-prompt unit. Goal and facets, division of labor,
  recording contract, evidence and instruction guidelines.
- `<skill>/SKILL.md`: one entry per poison. Frontmatter: `name` equals the
  directory, `description` is the poison and its differential, `facet` is
  `position`, `chart`, or `advance`, `entry` lists who may start the body
  from `learner`, `model`, `system`.
- `procedures/*.md`: shared bodies included by `@procedures/<name>.md`
  lines. Not entries; never started on their own. Structure guidelines
  travel inside `graph-authoring.md`.

## Loading

`src/skills.ts` builds the catalog. Always loaded: `base.md` and the index
of every learner- or model-startable entry, grouped by facet. On
invocation: the entry body with its includes inlined, so every delivered
bundle stands alone. Entries without `model` in `entry` are annotated in
the index as suggest-only; the model proposes them and the learner starts
them. Entries with only `system` are absent from the index and are read
by the host at their event.

`bun run build:skills` writes every entry to the generated
`packages/core/dist/pedagogy/skills/<name>/SKILL.md` catalog for a platform-root
Pedagogy-package release. Each bundle has Agent Skills frontmatter and an
inlined body. Namespaced `concept-facet` and `concept-entry` metadata preserve
the catalog requirements for release and harness consumers; entries without
`model` also set `disable-model-invocation: true`. A harness must omit
system-only bundles from the model's mounted directories.

## Executable boundary

The concrete `defaultPedagogicalTheory` supplies read, recording and background
factories. `attach_claim` and `refine_records` are for system sweep/revision
work; the host mounts them only with its full-log, revision-fenced projection
port. Recording tools append Records, never accept a learner label as input.
The catalog names every theory tool; `default-catalog.test.ts` compares that
vocabulary with the real assembled factories and walks stories A–C through
live in-memory host ports. It is Core composition evidence, not evidence that
an Application has mounted the package or implemented its background jobs.
Host graph/Confirmation/task/review affordances are conditional on what is
actually mounted; the catalog never claims a missing operation succeeded.
