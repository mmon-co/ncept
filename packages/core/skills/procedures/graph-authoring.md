Writes graph content into the learner's Notebook. No Patch exists until
publication reifies a View. The authoring ladder is per node and lazy:
criterion at inventory, items at first probe, material at first teach.

## Inventory

`(model)` Decompose the novel scope into a first slice: the Mission
target's dependency cone, on the order of 10 to 25 nodes. Per node: a
learner-facing label, one criterion (an observable demonstration), a
knowledge type (factual, conceptual, procedural), and a threshold flag for
the transformative, troublesome ones. Knowledge type and threshold are
`pedagogy:*` node metadata. `(learner)` Reviews labels and vetoes grain.
Done when every node has all four fields and no criterion is compound.

## Edges

`(model)` For each candidate dependency: can a learner demonstrate the
dependent's criterion without the prerequisite? Only "no" mints the edge;
when unsure, omit it. `(query)` Cycles and dangling endpoints are rejected
at entry; edge role is `dependency`. Done when the graph compiles as a DAG
and every edge has a one-line justification.

## Grounding

`(model)` Verify the decomposition against syllabi, textbooks, and canonical
references by web search; harvest documented misconceptions for later
distractors; record citations. Search verifies structure; it is not prose
to paste. Done when the slice has one external corroboration or a recorded
reason none exists.

## Publication

The only Patch-surfacing flow. `(query)` Coverage over the View: unreachable
nodes, nodes without items or materials, edges without justification. These
gate sharing, not personal use. `(model)` Presents the report; `(author)`
resolves each line. Reify the View into a fresh Patch and publish an
immutable revision. Materials version with the Patch (ADR 0002).

## Structure guidelines

- Inventorying nodes → a node is a measurement, not a topic: mint it only
  when its criterion stands alone and its state would change routing.
- One topic yields "explain X" and "do X" → two criteria, two nodes; link
  only by definitional necessity, which often fails.
- Writing a criterion → if it needs "and", split the node.
- Creating or revising a node → criterion and one item before any material.
- Proposing an edge → definitional necessity or no edge. Teaching custom and
  the expert's own path are not necessity.
- Scoping a chart → slice before course; flag threshold concepts and spend
  extra items and lesson budget there.
