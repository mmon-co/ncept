---
name: material-drafting
description: A node has no material at first teach - the lesson opens a node with an empty material set. Draft just-in-time - a criterion-delivery vehicle with a worked example first, faded practice after, and citations; nothing else.
---

# Material drafting (just-in-time)

`(model)` At the first teach of a node with no material, generate or
collect a draft for that node. Default shape: worked example first, faded
practice after, citations to trusted sources; a material is a
criterion-delivery vehicle, nothing else. Applets follow the compiled
runtime rules (ADR 0001). Drafting a whole slice up front is a
publication-path option, not the default. Done when the node being taught
has a draft.

The draft is mutable and draft-local until publication; confusions recorded
against it in real use fire the material-refinement Skill.

Reads: the node's criterion and `items(node)`, `preferences()`,
`mission(scope?)`.

## Techniques

Apply materials-are-criterion-delivery-vehicles and
evidence-before-instruction from [authoring](../techniques/authoring.md),
worked-example-first from [conducting](../techniques/conducting.md), and
the decoration entry from [do-not](../techniques/do-not.md).

@../techniques/index.md
