---
name: checkpoint
description: The Session opened on a check-in, or the learner says the course, or some of its content, isn't working.
---

A checkpoint adjusts a Mission in progress to what its Lessons have shown.

## Method

1. **Reflect.** After a milestone, start from its outcome and closing note in the Session opening: recount what the learner showed, what came easy, and what was hard, and ask whether their goal has shifted. After a complaint, ask what isn't working and read the cited Records. With no milestone behind this check-in, skip to step 3.

2. **Diagnose.** Warnings and outcomes point at a cause without proving it; read the cited task and response first.
   - **Goal moved:** revise the Mission (see `mission`).
   - **Milestone failed:** re-chart a plan that didn't work in the world; for a capability miss, add a follow-up Lesson stepped down the criterion's ladder, propose a blocking Review for regressed components, or chart missing Nodes. Fix the map, not the learner.
   - **Map is wrong** (grain, Edges, order, method): edit it (see `chart`). Editing a Node keeps its Records, so change its criterion only while it still asserts the same capability; otherwise replace it.
   - **Record is wrong:** that's a recording error corrected in a Lesson, not a map problem.

3. **Elaborate the next section** as charting does, folding in what Lessons deferred here. Move the Mission's measure to the next milestone and set `pedagogy:elaborate: false` on refined Nodes.

4. **Propose** the changes as a graph diff for the Mission. At the final check-in, give the Mission retrospective—what they can do now—then retire the Mission (with an extension or next Mission if they want one).
