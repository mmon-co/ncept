---
name: recording-review
description: Something already recorded seems wrong. Fires when the learner disputes a recount or trail view, or when you suspect a record yourself. Differential - one record is local; the same complaint recurring across nodes is structural, either the theory's parameters or the topology. Topology goes to realignment.
facet: position
entry: [learner, model]
---

# Recording review

Observations are append-only. Every correction is a new commit with
history; nothing is rewritten.

1. `(query)` `trail(node)`: the node's Observations in learner terms: when,
   what happened, how it was interpreted.
2. Local, one record:
   - Wrong node → re-point the association. New Association commit; the
     Observation is untouched.
   - Wrong interpretation → re-interpret the payload under the current
     theory through evaluate below. The old interpretation is superseded.
   - Stale claim ("I've forgotten this") → a new experience Observation.
     Uncertainty aging already prices time.
3. Structural, the complaint recurs across nodes:
   - Parameters (estimates move too fast or too slow, guided work counts
     too much, uncertainty ages wrongly) → propose one named parameter
     override with the records behind it. This is gated: the learner
     accepts before you write it. On acceptance write the user-scoped
     override and refold. Never edit the theory or the code.
   - Topology (the same failure sits on nodes sharing a suspect edge or
     grain) → realignment.
4. `(query)` Refold. `(model)` Confirm to the learner what changed.

## Evaluate

@procedures/evaluate.md
