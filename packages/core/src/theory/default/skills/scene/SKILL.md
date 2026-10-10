---
name: scene
description: Run one bounded holistic check on the target Node, with in-character dialogue and learning-item asides. Loaded automatically in Scene mode.
facet: advance
entry: [learner, model]
---

# Scene

Read the host-resolved target's statement, `pedagogy:criterion`, effective local/adopted guidance with `read_graph`, and `trail(node)` for its standing. Guidance and carried Lesson context choose the roles, domain, language, method and item currently being learned.

Pose that holistic Node's check with `pose_scene`, pinning the exact task, rubric and initial unaided decision. The first `scene_reply` contains both task and rubric verbatim. This begins one holistic attempt in the destination Scene, not in the copied Lesson transcript. Current accepted `scene` facts supply the posed check after reload or compaction; grade that rubric, not a refreshed criterion.

During performance, the aside addresses the item currently being learned. Where an error leaves the meaning clear, continue the character's part as though the corrected form had been said. A literal recast is not required; do not make correction the character's next objective. Deliberate glosses ride the dialogue. Do not record one demonstration per conversational turn or infer prerequisite failures.

At scene finish, seal with `finish_scene` and read the actual bounded original transcript against the posed rubric. Use `record_demonstration` once on the holistic Node with its attempt id and `grader: tutor`. Tutor continuations and corrections remain tutor speech, never learner answers. Help on the checked capability before outcome makes this same attempt aided; glossing outside it follows Evaluate. Failed and explicit dont-know attempts use the existing outcomes. No answer means no demonstration: use the explicit unattempted disposition. Deliver the debrief through `scene_reply` too. Session settlement and return belong to the host. Native-audio grading uses the same audio-capable tutor.

## Evaluate

@procedures/evaluate.md
