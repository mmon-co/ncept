Read the capability statement, `items(node)`, `trail(node)` and the learner's saved preferences. Use a worked example, minimal supporting exposition, faded practice and trusted citations. Draft only what the current capability needs, not an entire course.

Lessons are rarely revisited; reference is. Keep one reference Document for the Patch (a cheat sheet, and a glossary where the subject has its own terms) and add to it as Nodes are demonstrated: a term enters once the learner can use it, one preferred term per concept with the aliases to avoid, defined with the glossary's own terms.

If refining, compare the actual learner confusion and posed tasks with the material. Fix the passage that obstructs the capability; avoid polishing text that no task requires. Material reading is not demonstration evidence.

For a Document lesson, use magazine syntax when it helps the reader: one `:::kicker` before the `#` display title, one `:::deck` after it, margin glosses at the term's first use, at most one `:::pull`, and a `:::try-it` per concept. The first prose paragraph after the deck gets a drop cap. Keep the worked example and trusted citation in the prose; an island is not evidence of learning. Keep reference Documents plain when this grammar does not fit.

```text
:::kicker
lesson · 虛詞
:::
# Two kinds of 之
:::deck
English "of" swallows a distinction worth seeing here.
:::

北冥有魚… :gloss[之]{note="between subject and predicate: nominalizes the clause"}

:::pull{label="the test"}
If "the fact that" fits, it is the other 之.
:::

:::try-it{label="try it · aided"}
化而為鳥…鵬之背: which use is this?
- modifier · "of" ✓ | Yes: 鵬之背 is modifier + head.
- nominalizer · "the fact that" | Try adding "the fact that"; it does not parse here.
:::
```

A try-it is local reading practice: the choice and feedback stay in the reader, not the learner model. Use the Quiz Playground for assessed Problems. The island names match the mmon essay template's `pull` vocabulary; these five names are the Document subset.

Open a draft through the host's mounted Material affordance. Keeping or revising a Document is that affordance's own add or edit, not a graph edit. Without it, present a suggestion; never claim a Document was saved. Publication is outside this procedure.

## Applet authoring

Use an applet when the learner benefits from a live, reusable interaction; otherwise prefer the lighter Document or Quiz. Its HTML is the applet source, and its `meta` declares `abi: "applet:1"`, the `"@concept/applet": "1"` library, tutor queries and commands. Keep game state private in the applet's persisted `state(json)`. For chess, keep the position and move list there and declare `queries: { summary: "$.summary" }`, where `summary` is part of that same state. This makes the existing `applet_inspect` tool's named summary query the tutor's view; do not create a second published summary store or scrape rendered DOM.

Declare commands as `meta.commands` entries with an `inputSchema`. A command is an asynchronous request to the mounted frame, not an immediate board mutation: handle it with `onCommand(async ({ id, name, input }) => ...)`, apply it, await `state(nextState)`, update the rendered board, then return a small JSON result. The tutor's command tool only acknowledges that it queued work; inspect the next tutor turn's attributed applet result for what the frame did. Use the supplied command `id` to make replay safe: the same opening can redeliver an unacknowledged command after remount, and a crash can replay browser side effects. This is not exactly-once execution.

In a Session, persist a move before asking the tutor to wake: `await state(nextState)` must finish before `await session.post(move, { wake: true })`. The post result says whether the wake was accepted or rate-limited; the post remains visible either way. All applets in the Session share a 6-per-minute wake bucket with capacity 2. A rate-limited post is not scheduled for a later turn. Wake only while timely help is useful; once help fades, keep posting moves without the wake option (or set it false). The learner can continue quiet play without tutor turns. The runtime and schema details live in `packages/web/public/applet/README.md`.
