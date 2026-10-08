---
name: planning
description: We do not know what to do next. Match intent to a Mission and choose a target with a reason. No fitting Mission needs a goal conversation; missing evidence calls for an offered probe, not a fabricated estimate.
facet: advance
entry: [learner, model]
---

# Planning

1. Read `mission(scope?)` and the saved preferences supplied with this conversation. Match the learner's request to an existing goal. No fit → conduct the conversation below. A knowledge Mission whose targets are all known is done: say so. Getting started, the Application's affordance Mission, is done when each of its three Nodes has an effective feature-use receipt; inspect `trail(node).state.featureUses` for each, regardless of the Node's competence label. When it is done, continue planning on the learner's own Mission already present; do not propose a second Common Concept Mission. If no learner Mission fits, clarify the goal. A new or changed goal belongs in Charting: use the current mode's allowed `switch_mode` route and default carry before proposing a Mission.
2. Read `coverage(scope?)`, `frontier(scope?)`, and `warnings(scope?)` even on an empty trail. They need no prior close event. Coverage lists Nodes with no Records; frontier lists reachable not-known Nodes, not an ordering.
3. Choose by goal membership, last success, label, available time and open Session membership. Read `trail(node)` for the rationale. Known content may still merit a check; `probes(scope?)` lists suspect and probably-known Nodes. When uncertainty matters, offer `/calibrate` for broad Mission coverage only if it is in this mode's catalog; otherwise use an allowed `switch_mode` before recommending it. A focused check belongs in the Lesson.
4. Read `route(target)` for the chosen target's not-known prerequisite cone in dependency order. Find the Mission-path Lesson containing the selected target, including a known target omitted by the route, and propose its Lesson opening with the current mode's allowed `switch_mode` route and default carry. The fixed Lesson snapshot, not the route, determines Session scope. A route Node that `warnings` reports as `coarse` is not lesson-sized: offer a check on its whole task first (the learner may already pass it, which makes its prerequisites probably known), and if that fails, offer the registry-permitted `switch_mode` to Charting for its prerequisites instead of a lesson.
5. Explain the choice and propose the matching Lesson through `switch_mode` when the registry allows it; do not invent a movement or carry. Warnings are facts: inspect citations before judging content. Recommend `/realignment` only if that learner-only Skill appears in the current catalog; otherwise use an allowed mode switch to reach the mode that mounts the needed edit tools. Nothing automatically starts an edit activity.

## Mission conversation

When missing content requires Charting or work belongs to another Lesson, use `switch_mode` only along a route listed for this mode, with its declared default carry. A learner-only non-mode Skill is started by its slash command when it appears in the current catalog; do not promise a Skill Confirmation. @procedures/mission-conversation.md
