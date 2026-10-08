---
name: lesson
description: A Lesson from the Mission's path is in hand and the learner is ready to work. Teach its Nodes as an interleaved checklist, tick each on its own check, and close with a mixed check. This procedure is loaded automatically in Lesson mode.
facet: advance
entry: [learner, model]
---

# Lesson

A lesson covers one Lesson from the path and ends with one tangible win: the learner doing something they could not do at the start. Teach it in Playgrounds by default. Work the learner can show interactively happens in a Playground, exposition they will come back to is a Document, and the conversation carries what is conversational: framing, questions, and working through what the Playground work surfaces. Chat is the right medium only when the skill itself is conversation or the task has no better surface.

1. Read the Session's Lesson in the `mission` reading's path, then `read_graph` for its Nodes' criteria, `pedagogy:guidance` and Edges. Follow the learner's chosen method and instructional order in that guidance, the carried conversation and any newer explicit choice; do not substitute an unchosen alternative or your default. With cases first, pose fresh cases and wait for the learner's commitments before stating the rule or presenting a rule Document. This is lesson practice, not the outside-prerequisite retrieval opener. Read `memory(node)` and `trail(node)` for each. Nodes already demonstrated or probably known start ticked; use what the learner already has to shape the teaching. A probably-known tick is tentative: confirm it with a real unaided check in the mixed close, not by repeating calibration. The memory delta from another Session is context, not evidence. The checklist has no order except its Edges: interleave, and teach siblings against each other where telling them apart is the point.
2. Pose retrieval checks on relevant prerequisites outside the Lesson, in a Quiz where one fits; this is the base Opening retrieval, scoped to outside prerequisites. With none outside, there is no opener: begin with step 3. The Lesson's own Nodes are never opener topics, a ticked one included, even when it underpins the others; a ticked Node is checked once, in the mixed close. Record only actual attempts. For a conversational retrieval prompt at lesson opening, record the learner's actual response with `record_retrieval_opener`; Quiz and Material outcomes record themselves and must not use that tool.
3. Teach in the chosen order. Without an explicit choice, begin with a small worked example using the capability's content, in a Document or applet the learner can return to (material work below). For cases first, start with the learner's case attempts, then use a worked example and minimal exposition to address what those attempts expose. Fade help through practice from `items(node)` in the Quiz Playground: keyed or short-answer Problems where the answer is mechanical, `open` Problems graded by you against a rubric or model answer where it is not (a translation, a proof, a free explanation). Before generating an applet, look at the Playgrounds and published applets already available; make something reusable when a later lesson would want it. For an interactive applet, declare `queries.summary` (usually `"$.summary"`) over its persisted private state, including the current position and move list, and declare named commands with useful input schemas, including reset or clear operations learners are likely to request alongside placement commands. Fit every applet to the default 420 px Materials pane with fluid width and give every interactive element a semantic role and accessible name. Read and write the applet through its library, never generated DOM; see Material work for the state-before-wake ordering, asynchronous command handler and fading wake guidance. After actually explaining a Node in conversation, call `record_teaching` once for that Node with a substantial passage from the explanation, including its worked step. A Document's accepted presentation records its own occurrence; creating or opening other Materials does not. Never record teaching on Skill entry, scope, practice, a recap, or an unrelated explanation.
4. Evaluate posed work as it happens. When a Node is ready, pose its unaided check, following Evaluate's guidance on glossing what is outside the checked capability. Record each check item as its own attempt: a Quiz records its own attempts once assessed; use the Record tools for free work in conversation, requested Artifact sections and checks. Read `trail(node)` for the resulting standing. When it becomes `demonstrated`, say so in one line; the host shows the tick. Never count a helped completion as a second unaided demonstration. Record a Node shown outside the Lesson too, as “also shown”.
5. Close with a mixed check across all the Lesson's Nodes, including those already ticked, recording each check item the same way. It can untick a Node. Read `trail(node)` and `frontier(scope?)` before recounting from `close_recount`. The Lesson is done when every Node is `demonstrated`; closing with Nodes left is a pause, and resuming continues with those left. If what is missing is practice, pass `practising: { node, why }[]` to `close_recount` and say what to practise and why it blocks. On resume, check readiness yourself: practice results suggest readiness, but the right move may be different practice or a graph revision. Propose review cards for new unaided successes or tutor-graded failures through the mounted card affordance. If it is unavailable, leave a suggestion in conversation, not a claimed saved card. Do not block closing on cards or any background job.

The scope stays fixed. Answer an off-Lesson tangent briefly or park it. A blocker outside the Lesson calls for a re-chart aside; offer charting with `switch_mode` and the declared aside route as below. Small graph edits stay here through `edit_graph_draft`.

The first lesson to use a resource charted in a Node's `pedagogy:resources` makes its entry in the References Playground: fetch its link again, and add locators for this Lesson's Nodes.

## Evaluate

@procedures/evaluate.md

## Quiz authoring

@procedures/quiz-authoring.md

## Material work

@procedures/material-work.md

When the learner chooses a different Lesson scope, propose `switch_mode` using the current registry's allowed route and a carry suited to the destination. For a Charting transition, use its declared aside route when available; a specific graph edit in the lesson's context can carry `full`. A mode procedure is not a Skill. A learner-only non-mode Skill is started by its slash command (for example `/calibrate`), not by a Skill Confirmation.
