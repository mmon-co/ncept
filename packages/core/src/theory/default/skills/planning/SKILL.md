---
name: planning
description: We do not know what to do next. Match intent to a Mission and choose a target with a reason. No fitting Mission needs a goal conversation; missing evidence calls for an offered probe, not a fabricated estimate.
facet: advance
entry: [learner, model]
---

# Planning

1. Read `mission(scope?)` and the saved preferences supplied with this conversation. Match the learner's request to an existing goal. No fit → conduct the conversation below. A knowledge Mission whose targets are all known is done: say so. Getting started, the Application's affordance Mission, is done when each of its three Nodes has an effective feature-use receipt; inspect `trail(node).state.featureUses` for each, regardless of the Node's competence label. When it is done, continue planning on the learner's own Mission already present; do not propose a second Common Concept Mission. If no learner Mission fits, ask what comes next and propose a new Mission over the same graph as you would a first; the trail carries over on its own.
2. Read `coverage(scope?)`, `frontier(scope?)`, and `warnings(scope?)` even on an empty trail. They need no prior close event. Coverage lists Nodes with no Records; frontier lists reachable not-known Nodes, not an ordering.
3. Choose by goal membership, last success, label, available time and open Session membership. Read `trail(node)` for the rationale. Known content may still merit a check; `probes(scope?)` lists suspect and probably-known Nodes. Offer learner-started probing when uncertainty about the learner matters.
4. Read `route(target)` for the chosen target's not-known prerequisite cone in dependency order. Ask the host to open the selected target plus the route's Nodes, including a known target omitted by the route. A route Node that `warnings` reports as `coarse` is not lesson-sized: offer a check on its whole task first (the learner may already pass it, which makes its prerequisites probably known), and if that fails, offer learner-started charting of its prerequisites instead of a lesson.
5. Explain the choice and leave a target for the lesson. Warnings are facts: inspect citations and offer realignment if content is defective; nothing automatically starts an edit activity.

## Mission conversation

When the selected work belongs to a different scope, offer the next Skill through `propose_skill` with `scope` set to `target`, `view` or `nodes` and `destination: { kind: new-session, mode: handoff, focus: ... }`. Use `side` when the learner should keep this planning Session open. @procedures/mission-conversation.md
