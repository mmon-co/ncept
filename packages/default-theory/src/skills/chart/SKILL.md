---
name: chart
description: A Mission, or the next section of one, needs graph content; or content is being designed for others to adopt.
---

Charting is dependency resolution from a settled Mission. When authoring a Patch for others, chart for a typical adopter's Mission.

## Method

1. **Survey how people get there.** Within the Mission's settled approach, check how courses, textbooks, syllabi, or practitioner playbooks and postmortems sequence this ground. Read structures, not full contents—Lessons pull in materials later. Use this to counter expert blind spot and recall bias.

2. **Find the macro organization.** Decide how the Mission's prerequisites naturally hang together: a sequence of real steps and the capabilities they need, several independently valuable skills, separately practiced strands (like vocab vs grammar), or a fractal "smaller circles" progression. Separately practiced paths are strand tags; the practice serving a strand goes in guidance on its tag, not as a Node.

3. **Choose milestones.** Pick a few milestones marking sections toward the targets:
   - Each milestone is a smaller Mission—a whole, realistic performance worth having on its own. Put whichever gets the learner doing the real thing soonest (even crudely) first.
   - Mark each section's closing Node `milestone: true` and give its criterion a ladder of simpler conditions down to the lowest viable whole task.
   - World-dependent outcomes (such as a stranger paying) suit milestones; a miss leads to re-charting at its check-in.
   - For a conjectured approach (purposeful practice), the next milestone is its measure: name in Mission assessment guidance the short task from it that a Lesson can open on, with its metric (time, rate, count) where it has one.
   - Milestone 0 holds what the learner says they already know or did, quoting their words as claims.

4. **Elaborate the first section.** Work back from its milestone Node into smaller prerequisites until each can be checked. Leave later sections coarse with `elaborate: true` for the check-in before them.

5. **Draft** with `edit_graph_draft`: use `nodes`, `edges`, `tags` and `targets`. For a large graph, write several batches against the same draft, with prerequisites before references in later calls. Use `operations` for advanced edits after the batch. In the ordered form, `put` adds or replaces keyed content, `retract` removes an own accepted Edge or metadata set, `mask-contribution` suppresses a base contribution, `delete` removes a draft key (`claim:node-id` for a claim), `claim` attaches verbatim learner wording, and `discard` clears the draft alone.

6. **Propose** the valid draft as a Mission or revision when setting Mission targets, or a graph diff when they don't change (content for others carries no claims). Don't write a syllabus; the theory derives the path.

## The graph

- **Nodes** are single capabilities or steps the learner wants for themselves—a target, or what a target cannot be shown without—titled as that want and defined by what shows them; charting an exam or existing curriculum keeps its own units instead. A point with no such Edge goes in a Lesson or guidance. Include only what the learner can and will do themselves—leave out work an agent can simply do or coordinating other people. Different presentations of one task are one Node.
- **Edges** express definitional necessity—the dependent cannot be demonstrated without the prerequisite—with the reason in `because`. Preferred teaching order is `priority`, never an Edge.
- **Splitting:** a part too large for one Lesson lacks a prerequisite step or capability (child Node), volume (tiers: top 50 words, then 100), or consolidation (thresholds: 60, then 90 wpm).
- **Review schedules:** set `review` to `{"kind":"fsrs"}` for what must be remembered, `{"kind":"never"}` for one-off steps, or `{"kind":"interval","days":30}` (choosing the period) for maintained states or capabilities that detrain. Defaults when unset: `never` for milestones, `fsrs` otherwise.
- **Reuse and grouping:** reuse an existing Node only unchanged (its metadata is shared across Missions). Group small Nodes checked together with a `lesson:<name>` tag within one section. Override adopted guidance in the Mission's own guidance, scoped to its Node.
