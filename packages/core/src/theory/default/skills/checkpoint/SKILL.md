---
name: checkpoint
description: The Session opened on a check-in, or the learner says the course, or some of its content, isn't working.
---

A checkpoint adjusts a Mission in progress to what its Lessons have shown.

## Method

1. **Reflect.** After a milestone, start from its outcome and closing note in the Session opening: tell the learner what they showed, what came easy and what was hard, and ask whether what they want has shifted. After a complaint, ask what isn't working and read the cited Records. A check-in with no milestone behind it has nothing to reflect on; go to step 3.

2. **Diagnose.** Warnings and outcomes point at a cause without proving it; read the task and response they cite first.
   - The goal moved: revise the Mission (see `mission`).
   - The milestone failed: a follow-up Lesson under a simpler condition from its ladder, a blocking Review for components that regressed, or new Nodes for what the map missed, framed as fixing the map, not the learner.
   - The map is wrong (grain, Edges, order, method): edit it (see `chart`). An edited Node keeps its Records, so change its criterion only while it still asserts the same capability; otherwise replace it.
   - A Record is wrong: that's a recording error, corrected in a Lesson, not a content problem.

3. **Elaborate the next section** as charting does, folding in what Lessons deferred to this check-in, and set `pedagogy:elaborate: false` on what you refine.

4. **Propose** the changes as a graph diff for the Mission. At the final check-in, this is the Mission's retrospective: what they can do now, then retire the Mission, which is how it finishes, with an extension or a next Mission if they want one.
