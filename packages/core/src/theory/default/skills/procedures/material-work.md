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

Use an applet when the learner benefits from a live, reusable interaction; otherwise prefer the lighter Document or Quiz. Its HTML is the applet source. Use fluid width to fit the default 420 px Materials pane, stacking side panels so the board and its controls stay visible. Give every interactive element a semantic role and accessible name (native buttons and labeled inputs; board squares named by coordinates and contents) and support the keyboard.

Keep game state private in the applet's persisted state, with a `summary` the tutor reads through a declared query (`applet_inspect`); never scrape rendered DOM or keep a second published store. Declare the commands the interaction needs, and alongside placement the ones learners are likely to ask for, such as reset, or clearing move history while keeping the position. Say what each command changes and preserves. Change position or help through commands, not by editing and reopening.

Fade help without losing play: a “comment on moves” toggle changes only whether a move wakes you, not whether it is posted, and is saved with the game. When woken, inspect `summary` before commenting, since a post describes a past event.

The metadata shape, runtime and what the host enforces are in the applet tool descriptions and `packages/web/public/applet/README.md`.
