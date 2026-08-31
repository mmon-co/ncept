---
name: course-revision
description: The chart contradicts outcomes - revision signals cross the Pedagogical theory threshold at refold. Diagnose each signal as a content, structure, or item defect with its supporting records, propose the delta, and apply it through the authoring flow. A long interactive patch-editing process; suggest it and let the author start it.
disable-model-invocation: true
---

# Course revision from outcomes

The slow loop: evidence accumulated across sessions feeds back into the
content. Learner evaluation updates Learner state continuously; here the
Patch itself is the thing being graded.

Reads: trails aggregated over the scope (one learner for a personal Patch;
many for a published one), `items(node)` outcomes, route usage.

## Steps

1. `(query)` `signals(scope)` over the aggregated trails, checked at
   refold:
   - Mistake clusters: repeated mistakes sharing a misconception id, or the
     same confused-with pair recurring across learners.
   - Suspect edges: failures on a node whose prerequisites the same learner
     had demonstrated. Either the edge misses a real prerequisite or the
     node is too coarse.
   - Suspect grain: a node whose trail alternates success and failure
     without converging; its criterion probably covers two things.
   - Dead items: always answered correctly (recognition ceiling, no
     information) or never correctly (miskeyed or unfair).
   - Unused content: nodes never routed through, materials never opened.
     The instrument surfaces signals with their supporting records; it
     diagnoses nothing.

2. `(model)` Diagnose each signal as a content defect (material teaches the
   wrong thing), a structure defect (edge or grain), or an item defect.
   State the diagnosis with the records that support it.

3. `(model)` Propose the delta: node splits with new criteria, edges added
   or removed (re-run the definitional necessity test either way), items
   retired or rewritten, materials sent to refinement, and for recurring
   misconception clusters a new named distractor in the relevant items.
   `(author)` Approves per line.

4. Apply the approved delta through the authoring flow for the affected
   subset, producing a new revision:

@../snippets/graph-authoring.md

@../snippets/item-authoring.md

5. `(query)` Refold under the new topology; associations remigrate per the
   Calibration rules. `(model)` Tells affected learners what changed and
   why, in terms of their own trail ("your repeated X error turned out to
   be the course's fault; the material now addresses it").

Emits: a new Patch revision, retired and new items, Association commits
from remigration. For personal Patches, step 3 can run inside an ordinary
session; for published Patches it is an author-side workflow with aggregate
data and no learner identities.

## Techniques

Apply definitional-necessity and one-criterion-per-node from
[authoring](../techniques/authoring.md), and misconception-mapped
distractors from [calibrating](../techniques/calibrating.md).

@../techniques/index.md
