---
name: chart
description: A Mission, or the next section of one, needs graph content; or content is being designed for others to adopt.
---

Charting is dependency resolution from a settled Mission. With no learner, as for a Patch others will adopt, chart for a typical adopter's Mission.

## Method

1. **Survey course structures.** Within the approach the Mission settled, find how courses, textbooks and syllabi organize this ground. Read their outlines, not their contents; Lessons pull in materials later. The outlines are your checklist for comprehensiveness, against charting only what comes to mind first.

2. **Find the macro organization.** What's the macro level organization of the Mission's prerequisites? Is it the composition of several separate, independently valuable skills or understandings, as with a knowledge domain? Should it be broken into separately practiced paths, like vocab vs grammar for a language? Is it fractal-like via "making smaller circles"? Separately practiced paths are strand tags; the practice serving one is guidance on its tag, not a Node.

3. **Choose milestones.** A few milestones mark sections of progress toward the targets. Each is a smaller Mission: a whole performance worth having on its own, checked by using its section together. First is whichever gets the learner doing the real thing soonest, even crudely. Set `pedagogy:milestone: true` on the Node ending each section, and give its criterion a ladder of simpler conditions down to the lowest viable whole task. Milestone 0 holds what the learner says they already have, their words quoted as claims.

4. **Elaborate the first section.** Recursively, starting from its milestone Node: is its new part small enough for one lesson? If not, how can that new part be broken into smaller prerequisites? Leave later sections coarse with `pedagogy:elaborate: true`, for the check-in before them.

5. **Propose** the draft as a revision setting the Mission's targets, or as a graph diff when they don't change; content for others carries no claims. Don't write a syllabus; the theory derives the path.

## The graph

- A Node is one capability, defined by the demonstration that shows it. Different presentations of one task are one Node.
- An Edge means the dependent can't be demonstrated without the prerequisite; give the reason in `pedagogy:because`. Teaching order is `pedagogy:priority`, never an Edge.
- A part too big for one lesson lacks a capability (a child Node), volume (tiers: the top 50 words, then 100) or consolidation (thresholds: 60, then 90 words a minute).
- Reuse an existing Node only unchanged: its metadata is shared with every Mission that uses it.
- Group small Nodes taught together with a `lesson:<name>` tag, inside one section.
- A learner's override of adopted guidance goes in their Mission's guidance, scoped to its Node.
