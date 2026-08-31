---
name: calibration
description: The position estimate is wrong or stale. Signals - the learner is visibly out of the zone (too easy or too hard), a coverage gap, staleness blocking a pending decision, a learner claim to probe, or surprise mid-session. Competing diagnoses - wrong support is fixed in-lesson by adjusting scaffolding; a wrong estimate needs this probe loop. Suggest it and let the learner start it; it repurposes the session into a multi-question interactive loop.
disable-model-invocation: true
---

# Calibration conducting

Shrink uncertainty where it blocks planning, at the lowest evidence cost
that works. Calibration produces Observations like any other session; the
fold is the same. Calibration is never scheduled. It fires on a coverage
gap (including the handoff from charting, which passes the Mission and the
creation session's Observations), on staleness blocking a pending decision,
on a learner claim to probe, or on surprise mid-session.

Name the diagnosis first: a learner out of the zone means either a wrong
estimate or wrong support. Wrong support is an in-lesson adjustment (fade
or add scaffolding, per the conducting techniques); only a suspect estimate
warrants this probe loop.

Reads: `competency(scope)`, `coverage(scope)`, `probes(scope)`,
`items(node)`, `trail(node)`, `mission(scope?)`.

## Steps

1. `(query)` `probes(scope)`: nodes ranked by uncertainty weighted by
   topological value (how many mission-relevant nodes depend on them) and
   staleness. The instrument ranks; it does not choose.

2. `(model)` Agree on a budget with the learner: default question count and
   the option to stop early. Ask for the learner's own sense of what they
   know; record it as an experience Observation and use it to order probes,
   never as evidence.

3. Probe loop, one question at a time, until step 4 stops it:
   - `(model)` Pick the next probe from the ranked candidates. Prefer an
     authored item from `items(node)`; author one on the fly only when the
     bank is empty, per the item-authoring guidance below.
   - `(learner)` Answers, optionally with a comment.
   - Grade: `(query)` A commentless multiple-choice answer maps
     mechanically through the option's default interpretation, capped at
     recognition. `(model)` A comment or free response is interpreted as a
     whole (SOLO mapping, per the recording contract).
   - Escalate on surprise: when the answer strongly contradicts the
     estimate in either direction, climb the format ladder for that region,
     multiple choice to free response to a short assignment, before moving
     on.
   - Emit the Observation: native payload holds item id, choice, latency,
     comment; interpretation holds the graded evidence.

4. Stop when any of: the budget is spent; the probed region's uncertainty
   falls below the Pedagogical theory's stopping threshold; the learner
   ends it. Every stop is legitimate; there is no failed calibration.

5. Close. `(query)` Refold. `(model)` Show the learner their updated map in
   plain terms: what looks solid, what looks shaky, what was not touched,
   and what the next lesson would be. Done when the learner has seen the
   map.

Emits: one experience Observation (self-assessment), one evidence
Observation per probe, the refolded Learner state.

## Item authoring

@../snippets/item-authoring.md

## Techniques

@../techniques/calibrating.md

Also apply the retrieval opener from
[conducting](../techniques/conducting.md).

@../techniques/index.md
