---
name: dispute-triage
description: The record misrepresents the learner - a recount or trail view is disputed. Triage the dispute - wrong node re-points the association, wrong interpretation re-interprets the payload, a stale claim records new experience. Untreated, a wrong record poisons planning, the progress facade, and trust in the map.
---

# Dispute triage

The doorway is any recount or trail view, one turn away in chat. The
Observation itself is never rewritten; evidence is append-only, and every
correction is a new commit with history.

1. `(query)` `trail(node)` renders the node's Observations in learner
   terms: when, what happened, how it was interpreted.

2. `(learner)` Disputes a record. Three cases:
   - Wrong node: re-point the association. New Association commit; the
     Observation is untouched.
   - Wrong interpretation: re-interpret the native payload under the
     current Pedagogical theory. The old interpretation is superseded, not
     deleted.
   - Stale claim ("I've forgotten this"): record a new experience
     Observation; never rewrite history. Uncertainty aging already prices
     time.

3. `(query)` Refold; `(model)` confirms to the learner what changed.

Emits: Association commits from corrections, refolded Learner state.

## Techniques

@../techniques/evaluating.md

Also apply the recognition ceiling from
[calibrating](../techniques/calibrating.md).

@../techniques/index.md
