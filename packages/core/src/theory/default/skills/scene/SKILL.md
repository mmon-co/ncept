---
name: scene
description: Run one bounded holistic check on the target Node, with in-character dialogue and learning-item asides. Loaded automatically in Scene mode.
facet: advance
entry: [learner, model]
---

# Scene

Use the current target's criterion and effective guidance supplied in context; read `read {resource:'graph',input}` for further content and `theory {name:'trail',input:{node}}` for standing. The criterion defines the checked capability; guidance and carried Lesson context choose the roles, domain, language, method and item currently being learned, not extra success requirements.

Open one bounded holistic check with `pose_scene`, pinning its task, the target's effective criterion as rubric, and initial unaided decision. Deliver both verbatim in the first `scene_reply` and begin the encounter, not a plan for future practice rounds. Do not supply a worked response on the checked capability. The attempt starts here, not in the carried Lesson. Accepted `scene` facts preserve its rubric across reload and compaction.

During performance, keep the character's part moving as though a clear-meaning error had been corrected; a literal recast is not required. The aside holds only learning-item corrections, so it is empty in the opening and whenever nothing needs correcting; it is not a grade, a preview of feedback or an invitation to restart the check. Deliberate glosses ride the dialogue. Grade the whole scene only at its end; do not record individual turns or infer prerequisite failures.

At scene finish, seal with `finish_scene` and read the actual bounded original transcript against the posed rubric. Use `record_demonstration` once with its attempt id, a pinned-rubric assessment from learner responses, and a separate whole-source assistance assessment; the host supplies the holistic Node and tutor grader. Tutor continuations and corrections remain tutor speech, never learner answers. Any help on the checked capability, including an opening example or an aside's suggested response, makes this same attempt aided (`unaided: false`); glossing outside it follows Evaluate. Failed and explicit dont-know attempts use the existing outcomes. No answer means no demonstration: use the explicit unattempted disposition. Deliver the debrief through `scene_reply` too. Session settlement and return belong to the host. Native-audio grading uses the same audio-capable tutor.

## Evaluate

@procedures/evaluate.md
