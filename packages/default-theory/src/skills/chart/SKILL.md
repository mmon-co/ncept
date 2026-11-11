---
name: chart
description: A Mission, or the next section of one, needs graph content; or content is being designed for others to adopt.
---

Charting is dependency resolution from a settled Mission. With no learner, as for a Patch others will adopt, chart for a typical adopter's Mission.

## Method

1. **Survey how people get there.** Within the approach the Mission settled, find how courses, textbooks and syllabi organize this ground, or how practitioners who reached a goal in the world sequenced it: playbooks and postmortems. Read the structures, not their contents; Lessons pull in materials later. These are your checklist for comprehensiveness, against charting only what comes to mind first.

2. **Find the macro organization.** What's the macro level organization of the Mission's prerequisites? Is it a sequence of real steps and the capabilities they need, or several separate, independently valuable skills or understandings, as with a knowledge domain? Should it be broken into separately practiced paths, like vocab vs grammar for a language? Is it fractal-like via "making smaller circles"? Separately practiced paths are strand tags; the practice serving one is guidance on its tag, not a Node.

3. **Choose milestones.** A few milestones mark sections of progress toward the targets. Each is a smaller Mission: a whole performance worth having on its own, checked by using its section together. First is whichever gets the learner doing the real thing soonest, even crudely. Set `pedagogy:milestone: true` on the Node ending each section, and give its criterion a ladder of simpler conditions down to the lowest viable whole task. An outcome that also depends on the world, such as a stranger paying, suits a milestone; a miss leads to re-charting at its check-in. Milestone 0 holds what the learner says they already have or did, their words quoted as claims.

4. **Elaborate the first section.** Recursively, starting from its milestone Node: does its new part fit one Session at the learner's minutes per Node? If not, how can that new part be broken into smaller prerequisites? Leave later sections coarse with `pedagogy:elaborate: true`, for the check-in before them.

5. **Propose** the draft as a revision setting the Mission's targets, or as a graph diff when they don't change; content for others carries no claims. Don't write a syllabus; the theory derives the path.

## The graph

- A Node is one thing the learner can show or has done, defined by what shows it. Steps depend on what the learner can and will do themselves; work an agent could simply do is done by the tutor or left out, and coordinating other people stays outside. Different presentations of one task are one Node.
- An Edge means the dependent can't be demonstrated without the prerequisite; give the reason in `pedagogy:because`. Teaching order is `pedagogy:priority`, never an Edge.
- A part too big for one Lesson lacks a prerequisite step or capability (a child Node), volume (tiers: the top 50 words, then 100) or consolidation (thresholds: 60, then 90 words a minute).
- Set `pedagogy:review: false` on one-off steps. Capabilities retain Review through another real instance; maintained states retain Review by checking whether they still hold.
- Reuse an existing Node only unchanged: its metadata is shared with every Mission that uses it.
- Group small Nodes taught together with a `lesson:<name>` tag, inside one section.
- A learner's override of adopted guidance goes in their Mission's guidance, scoped to its Node.
