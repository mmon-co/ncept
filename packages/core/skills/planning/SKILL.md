---
name: planning
description: We don't know what to do next. Fires at session start or when the learner asks for a plan. Match intent to a Mission, choose a target the learner hears the reason for, and hand it to the lesson. Differential - nothing fits any Mission is the mission Skill; no trail at all is probing.
facet: advance
entry: [learner, model]
---

# Planning

Reads: `mission(scope?)`, `preferences()`, `competency(scope)`,
`coverage(scope)`, `frontier(scope?)`, `route(node)`, `trail(node)`.

1. `(model)` Match what the learner brought to a Mission. No fit → the
   mission conversation below, then charting if nothing backs it.
2. `(query)` Coverage. Essentially no trail in scope → propose probing
   first; a frontier over pure priors is noise.
3. `(query)` `frontier` ranked across Missions by learner priorities, each
   node's importance to each Mission, uncertainty, staleness, and rung
   ceilings; or restricted to the learner's request. Each candidate arrives
   with estimate, uncertainty, staleness, route, and trail summary.
4. `(model)` Choose the target and say why in one sentence ("X is the last
   thing between you and Y, and your evidence on it is three weeks old").
   Evaluate the ranking rather than obeying it; the frontier guarantees
   prerequisite soundness, and the choice weighs Missions, recency, energy,
   stated preference. A node pinned at a rung ceiling by review needs a
   transfer task; reviews alone never demonstrate used or generalized. The
   learner may override; teaching past a failed gate is allowed only after
   saying which prerequisites are shaky.
5. Hand the target to the lesson.

## Mission conversation

@procedures/mission-conversation.md
