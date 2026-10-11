---
name: authoring
description: Design a Patch for other people to adopt, working backward from its audience and outcomes rather than the author's learner state. This procedure is loaded automatically in Authoring mode.
facet: chart
entry: [learner]
---

# Authoring

Make reusable learning content with the author, not a Mission for the author. Start from the goal entry's audience and outcome; if absent, ask who the Patch is for and what they should be able to do. Set its scope and intended grain together. Work backward: outcomes, then the demonstrations that would establish them, then activities and sources that prepare an unknown cohort for those demonstrations. Offer judgments and settle choices in conversation before transcribing them.

Do not prune content by what the author knows, test the author, or record claims about them, including draft `claim` entries. Cover the whole agreed scope at the intended grain, or deliberately make a coarse template with `pedagogy:elaborate: true` for adopters to chart. Write criteria, entry points, guidance and bases for whoever adopts it, not for this author's preferences or trail. Reuse fitting content unchanged; make new Nodes when criteria or guidance differ. Research sources, fetch cited URLs, and check their licenses permit redistribution before embedding their content; preserve source and license attribution. If permission is unclear, cite rather than copy.

## Graph draft

Work in the selected Profile's graph, usually a Scratch Profile. The Session is already an edit session. Use these graph mechanics for the cohort design; references to learner choices mean the intended adopter's design, not the author's competence. Do not write claims or propose a Mission.

@procedures/graph-authoring.md

Review the complete draft with the author: outcomes covered, criteria demonstrable, prerequisite Edges necessary, and coarse sections intentional. Apply revisions, then submit one `propose_graph_diff({ viewName: "Patch name" })` for acceptance. This saves or revises the Session's target View with the authored targets in the same acceptance; use the agreed Patch name. The content exists only after successful acceptance.

## Materials

Author only Materials the agreed design needs, with activities serving its evidence and outcomes. Use the following Material mechanics for intended adopters: do not wait for the author to demonstrate Nodes, or personalize by their saved preferences. A reusable reference may cover the agreed Patch scope immediately. Applets are not mounted in this mode; prefer Documents or Quizzes.

@procedures/material-work.md

## Pass it on

Publication uses the existing capture → inspect → name → publish lifecycle, not a separate preview. After acceptance, the saved target View is ready to capture in Hub → Yours. Load `app-help` for application instructions. Trying it as a learner means adopting the named release into another Profile, just as another person would.
