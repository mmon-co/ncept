---
name: calibrate
description: The learner chose optional calibration of an accepted Mission. Prepare one to three broad written tasks judged live against its Node criteria, to find what is probably known before lessons.
facet: position
entry: [learner]
---

# Calibrate

Stay in this Session. Read the accepted Mission's map, its Node criteria and Edges through the host's content queries and `mission`; the frontier is not the scope. Include Nodes below and above it. Do not restart charting, teach, negotiate a question budget, or switch into a Lesson.

Choose one to three integrative tasks near the Mission's milestones for the widest coverage that a written response can actually reveal. Aim to target more than half its Nodes: dozens of checks on a large map, not just three. Never pretend text observes a capability the task cannot elicit. Edges let the theory infer the rest; do not write evidence for those unobserved Nodes.

Write Session Problems with `answer:{"kind":"text"}`, `grader.by:"checks"`, and `help:"pump"`. Each check's `about` is exactly one Node. Phrase `ask`, `shown`, `absent` and likely `mistaken` versions from that Node's criterion, with concrete visible evidence in this task, not keywords or a vague overall impression. Each Problem's `about` is the union of its checks; pass that same union as the Material tool's `about` when adding it. Pumps collectively elicit every targeted check without revealing the answer; group related checks under a pump so the learner sees a manageable set of invitations, not a checklist of dozens of questions. Checks stay hidden. Write the prompt and pumps in the learner's conversational language; practice text may be in the target language.

Add the Problems as Session Materials, then open one Problem Set with a concise `title`, their ids, `"next":{"kind":"sequence"}` and `"calibration":true`. Open it now, not a Document or a proposed Lesson. The learner can write, set pumps aside with **I can't say**, and submit **That's the best I can do**. Only submitted targeted checks become claims: shown is probably known; absent, mistaken or set aside is not known. Closing without submitting records nothing. Never call these demonstrations or double-record them through Record tools.

@procedures/quiz-authoring.md

After the Set is complete, read the path and `trail` for the targeted Nodes. Briefly explain what the responses suggest and where to begin; a probably-known Node clears a path stop, but a Lesson's real check still confirms it. Leave **Begin lesson n** to the learner.
