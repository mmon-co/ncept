---
name: lesson
description: A target is in hand and the learner is ready to work. Teach a route step, its target and not-known prerequisites, with a separate demonstration for each capability. Retrieve, present, practice, recount.
facet: advance
entry: [learner, model]
---

# Lesson

A lesson is short and ends with one tangible win: the learner doing something they could not do at the start. Teach it in Playgrounds by default. Work the learner can show interactively happens in a Playground, exposition they will come back to is a Document, and the conversation carries what is conversational: framing, questions, and working through what the Playground work surfaces. Chat is the right medium only when the skill itself is conversation or the task has no better surface.

1. Read `route(target)`. Use the selected target plus the route's Nodes as the host-opened Session scope, even when the target is already known. Read prefetched `memory(node)` and `trail(node)` for every scoped Node. The memory delta from another Session is context, not evidence. If `warnings` reports the target as `coarse`, it is not lesson-sized: check the whole task, and if that fails, offer learner-started charting for its prerequisites instead.
2. Pose retrieval checks on relevant prior capabilities, in a Quiz where one fits. Record only actual attempts. For a conversational retrieval prompt at lesson opening, record the learner's actual response with `record_retrieval_opener`; Quiz and Material outcomes record themselves and must not use that tool. A gap can change the teaching order; a new scope requires the host to open a new Session rather than quietly expanding this Session.
3. Present a small worked example using the capability's content, in a Document or applet the learner can return to (material work below). Then fade help through practice from `items(node)` in the Quiz Playground: keyed or short-answer Problems where the answer is mechanical, `open` Problems graded by you against a rubric or model answer where it is not (a translation, a proof, a free explanation). Before generating an applet, look at the Playgrounds and published applets already available; make something reusable when a later lesson would want it. For an interactive applet, declare `queries.summary` (usually `"$.summary"`) over its persisted private state, including the current position and move list, and declare named commands with useful input schemas. Read and write the applet through its library, never generated DOM; see Material work for the state-before-wake ordering, asynchronous command handler and fading wake guidance. After actually explaining a Node in conversation, call `record_teaching` once for that Node with a substantial passage from the explanation, including its worked step. A Document's accepted presentation records its own occurrence; creating or opening other Materials does not. Never record teaching on Skill entry, scope, practice, a recap, or an unrelated explanation.
4. Evaluate posed work as it happens. A Quiz records its own attempts once assessed; use the Record tools for free work in conversation, requested Artifact sections and checks. Never count a helped completion as a second unaided demonstration.
5. When ready, pose each Node's unaided close check, in a Playground where the capability allows. Read `trail(node)` and `frontier(scope?)` now, not after close. Recount from `close_recount`. Propose review cards for new unaided successes or tutor-graded failures through the mounted card affordance. If it is unavailable, leave a suggestion in conversation, not a claimed saved card. Do not block closing on cards or any background job.

## Evaluate

@procedures/evaluate.md

## Quiz authoring

@procedures/quiz-authoring.md

## Material work

@procedures/material-work.md

When the learner chooses work in a different scope, offer its Skill with `propose_skill`, `scope` set to `target`, `view` or `nodes`, and `destination: { kind: new-session, mode: handoff, focus: ... }`. Use `side` when this Session should remain open for a parallel question.
