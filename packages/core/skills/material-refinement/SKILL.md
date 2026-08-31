---
name: material-refinement
description: Material confuses in real use - confusions are recorded against a draft. Refine the draft against the evidence spec (does it teach what the items test?), then publish an immutable revision. A long interactive editing process; suggest it and let the author start it.
disable-model-invocation: true
---

# Material refinement and publication

Materials are generated or collected in a mutable draft, refined against
the evidence spec, and published as an immutable revision. This is the
material half of authoring; the graph half is the charting Skill.

Reads: the draft under refinement, `items(node)` per node, `mission(scope?)`
and the Patch's intended audience, `trail(node)` where learners have
already used earlier drafts.

## Steps

1. Refinement sessions, per material:
   - `(query)` The node's criterion and items alongside the material.
   - `(model)` The alignment check: does this material teach what the items
     test? Passages that teach nothing any item tests get cut or moved;
     criteria the material never addresses get flagged back to authoring.
     Decorative additions are removed, not polished.
   - `(learner or author)` Reads, works an exercise, marks confusions.
     Their confusions are refinement input here, and evidence only if this
     is a real learning session. Done per material when it passes the
     alignment check and the reader found no dead passage.

2. Set review. `(query)` Orphan materials (attached to no node), nodes
   whose materials skip their criterion, audience mismatches against the
   intended audience statement. `(model)` Presents the report; `(author)`
   resolves each line. Done when the report is empty.

3. Publish. The draft becomes an immutable revision; Materials version with
   the Patch (ADR 0002). Existing learners' associations remigrate on their
   next Calibration, deferred if costly.

Personalized variants (a material regenerated for one learner's
preferences) follow the same steps but live in the Personal scope, never in
the shared Patch.

Emits: the published revision. Refinement feedback stays draft-local; it is
not learner evidence unless recorded through a genuine session.

## Techniques

@../techniques/authoring.md

Also apply worked-example-first and fade-with-competence from
[conducting](../techniques/conducting.md), and the decoration entry from
[do-not](../techniques/do-not.md).

@../techniques/index.md
