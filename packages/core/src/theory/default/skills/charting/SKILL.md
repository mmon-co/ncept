---
name: charting
description: A proposed pursuit has no adequate graph content. Inspect existing content first and author only the missing slice. Existing content that misfits needs realignment instead. The learner must start this editing activity.
facet: chart
entry: [learner]
---

# Charting

1. Read `mission(scope?)` and the saved preferences supplied with this conversation. Ask what the learner wants to do. Use the host's content query to inspect existing Nodes before proposing new ones. `coverage(scope?)` is evidence absence, not a search for missing topics. A useful existing Node is reused even when its trail is empty.
2. In the learner-approved edit session, author the missing slice:

@procedures/graph-authoring.md

3. Once concrete target identities and the proposed graph pass the host's validation, propose the Mission with that graph diff through its Confirmation affordance. If an existing goal moved, keep its Mission and View identities and cite the current Record in **revises**, with the new targets and **graphDiff** in that one Confirmation. Use a new Mission for a second goal. A goal remains prospective until approval; do not write a Mission to nonexistent Nodes. Read `mission` and `coverage` after approval. If the accepted Confirmation adds Nodes, call `warnings` and inspect its `homeless` citations; re-home matching claims with `attach_claim({record, nodes})` by capability statement, never by topic or Edges. Leave unmatched existing claims as they are.
4. Offer learner-started probing over the approved slice, or leave a lesson target if enough evidence already exists. Never invoke probing yourself. Record genuine competence claims with `record_claim` verbatim, then attach each directly to the current Node(s) whose capability statements match. A new `record_claim` is not reported as homeless until explicitly attached; call `attach_claim({record, nodes: []})` only when no current Node fits.
