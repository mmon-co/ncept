# Graph authoring: inventory, edges, grounding

## Node inventory

`(model)` Decompose the novel scope into a first slice: the mission
target's dependency cone, on the order of 10 to 25 nodes. For each node: a
learner-facing label, a criterion (one observable demonstration; if it
needs "and", split the node), a knowledge type (factual, conceptual,
procedural), and a threshold flag for the transformative, troublesome ones.
Apply the node-is-a-measurement test: mint a node only when its state would
change routing; otherwise it is material content inside another node.
"Explain X" and "do X" are different criteria and therefore different
nodes. `(learner)` Reviews labels and vetoes grain. Done when every node
has all four fields and no criterion is compound.

Knowledge type and threshold are authored `pedagogy:*` node metadata.

## Edges

`(model)` For each candidate dependency, apply the definitional necessity
test: can a learner demonstrate the dependent's criterion without the
prerequisite? Only "no" mints an edge. When unsure, omit the edge; the
expert's own learning path is not evidence, and procedure often precedes
understanding. `(query)` Cycles and dangling endpoints are rejected at
entry; edge roles are the validated enum, currently `dependency` only. Done
when the graph compiles as a DAG and every edge has a recorded one-line
justification.

## Source grounding

`(model)` Verify the decomposition against real syllabi, textbooks, and
canonical references by web search; harvest documented misconceptions
(concept inventories) for later distractors; record citations. Search
verifies structure and instruments; it is not prose to paste. Done when the
slice's shape has at least one external corroboration or a recorded reason
none exists.
