Read the capability statement, its `pedagogy:guidance`, `items(node)`, `trail(node)` and the learner's saved preferences. Order Materials by the learner's chosen method: cases first means case attempts before the rule or worked explanation, not a rule Document with cases at the end. Use a worked example, minimal supporting exposition, faded practice and trusted citations at the appropriate point in that order. Draft only what the current capability needs, not an entire course.

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

Use an applet when the learner benefits from a live, reusable interaction; otherwise prefer the lighter Document or Quiz. Its HTML is the applet source. Use fluid width to fit the default 420 px Materials pane without horizontal clipping; keep the board and supporting controls visible at that width, stacking side panels when needed. Give every interactive element a semantic role and accessible name: prefer native buttons and labeled inputs; name board-square controls by their coordinates and contents, and support keyboard operation. Declare metadata in this shape, adding the commands and queries the interaction needs:

```json
{
  "abi": "applet:1",
  "libraries": { "@concept/applet": "1" },
  "queries": { "summary": "$.summary" },
  "commands": {
    "setPosition": {
      "inputSchema": {
        "type": "object",
        "properties": { "fen": { "type": "string" } },
        "required": ["fen"],
        "additionalProperties": false
      }
    }
  }
}
```

Keep game state private in the applet's persisted state. For chess, keep the position and move list there, with `summary` part of that same state; the query is an RFC 9535 JSONPath expression over it. `applet_inspect` reads the declared query without running the frame. Do not create a second published summary store or scrape rendered DOM. The pinned library is provided only in the mounted frame, not the tutor's shell; verify through `applet_open` and the live browser frame, not by importing `@concept/applet` in `bash`.

Await the `init` handshake before reading restored state or capturing `session`: use `const initial = await init(); let game = initial.state ?? startingGame(); const session = initial.session;`. The host initializes the live `session` only after this handshake; capturing `session.post` earlier leaves it `null` and silently skips posts. The `state` function writes values; use `initial.state` for restoration, never invoke the writer without a value.

After `applet_add`, explicitly call `applet_open` to mount the new Material in the active Session; adding it only saves and lists it. The tutor's command tools for that opening are available when the next tutor turn is prepared.

An opening pins a Material revision and owns its private state. Editing source and opening the edited Material creates another opening, not an update to the learner's running board. Use declared commands to change positions or help settings during play; do not edit/reopen merely to fade help. If a source repair is necessary, explain that it is a new copy, inspect the old position and moves, and restore them through a declared command before asking the learner to continue. Never imply that an old opening's state automatically transfers.

Declare commands as `meta.commands` entries with an `inputSchema`. Include reset or clear commands alongside placement commands for requests learners are likely to make: for example, clear move history while retaining the current position, or reset the board. State which parts each command changes and preserves, implement it in the handler, and persist the result; do not rely on editing/reopening to clear a running applet. A command is an asynchronous request to the mounted frame, not an immediate board mutation: handle it with `onCommand(async ({ id, name, input }) => ...)`, apply it, await a `state` write with the next value, update the rendered board, then return a small JSON result. The tutor's command tool only acknowledges that it queued work; inspect the next tutor turn's attributed applet result for what the frame did. Use the supplied command `id` to make replay safe: the same opening can redeliver an unacknowledged command after remount, and a crash can replay browser side effects. This is not exactly-once execution.

In a Session, persist a move before asking the tutor to wake: `await state(nextState)` must finish before `await session.post(move, { wake: true })`. The post result says whether the wake was accepted or rate-limited; the post remains visible either way. All applets in the Session share a 6-per-minute wake bucket with capacity 2. A rate-limited post is not scheduled for a later turn. Wake only while timely help is useful; once help fades, keep posting moves without the wake option (or set it false). The learner can continue quiet play without tutor turns. The runtime and schema details live in `packages/web/public/applet/README.md`.

Keep the post outside the help condition: `await state(nextState); if (session) await session.post(move, { wake: helpEnabled });`. A “comment on moves” toggle changes only `wake`, not whether the move is posted. Persist that toggle with the game so reload does not re-enable help. Declare a command to change it without replacing the board. When woken, inspect the posting surface's `summary` before commenting on its current position; a post describes a past event and may no longer be the latest state.
