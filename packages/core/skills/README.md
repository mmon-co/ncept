# Pedagogy Skill library

The Agent Skills-compatible library generated from `docs/pedagogy` under
ADR 0008: one Skill per model-judged registry problem. Each Skill's
`description` states the problem and its signal — the descriptions together
are the registry index — and its body is the decision procedure, or an index
into the shared technique files where resolution is situational.

## Layout

- `base.md` — the base system-prompt layer: the goal, the division of
  labor, the scientific discipline, and the recording contract. Universal
  material lives here, outside the registry.
- `<skill>/SKILL.md` — one Skill per registry problem. YAML frontmatter
  carries `name`, `description`, and `disable-model-invocation: true` on
  Skills that radically change the session's purpose or run a long
  multistep user-interactive process; those are suggested by the model and
  invoked by the learner, never silently.
- `techniques/` — the shared technique library, one file per section, plus
  `index.md`, the one-line trigger index of the whole library.
- `snippets/` — shared but non-universal guidance referenced from bodies.
  Guidance is stored once; bodies include it by reference.

## Loading contract

Loading is two-tier.

- Always loaded: `base.md`, the registry index (every Skill's name and
  description), and `techniques/index.md`. The trigger index is always
  loaded because question answering has no Skill: it is opportunistic
  technique application in any session.
- Loaded on invocation: the Skill body. A line consisting of `@` followed
  by a relative path includes that file; a harness without a file surface
  inlines the includes mechanically at invocation (`skillBody` in
  `src/skills.ts` does this), and a harness whose model can read files may
  follow them as references instead.

The library is portable: any Agent Skills harness can load the Skill
directories directly, with `base.md` as (part of) the system prompt.
