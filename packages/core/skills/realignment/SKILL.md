---
name: realignment
description: The Mission's View is complete but does not match its statement or what the learner meant - revision signals cross the theory threshold at refold, or the learner says this is not what they wanted. Diagnose each signal as a View, structure, item, or material defect. Reframing the View starts freely; editing the Patch is proposed first.
facet: chart
entry: [learner, model]
---

# Realignment

Reads: `signals(scope)` over aggregated trails (one learner for a personal
Patch, many for a published one), `mission(scope?)`, `items(node)`.

1. `(query)` `signals(scope)`, checked at refold, each with its records:
   mistake clusters sharing a misconception or confused-with pair; suspect
   edges (failures where the same learner had demonstrated the
   prerequisites); suspect grain (a trail alternating success and failure
   without converging); dead items (never or always correct); unused
   content.
2. `(model)` Diagnose each signal with the records that support it:
   - View defect: wrong target Nodes or wrong query → reframe the View.
     Also the case when the learner's intent has moved but the Mission
     statement stands.
   - Structure defect: edge or grain → graph authoring.
   - Item defect → quiz authoring: retire, rewrite, or add a named
     distractor for a recurring misconception.
   - Material defect → material work, refine mode.
3. Propose the delta. This is gated for any Patch edit: `(author)` approves
   per line before anything is written.
4. Apply through the procedures below, producing a new revision.
5. `(query)` Refold under the new topology; associations remigrate.
   `(model)` Tell affected learners what changed and why, in terms of their
   own trail. For published Patches this is author-side with aggregate data
   and no learner identities.

## Graph authoring

@procedures/graph-authoring.md

## Quiz authoring

@procedures/quiz-authoring.md

## Material work

@procedures/material-work.md
