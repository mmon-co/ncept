---
name: lesson
description: We don't know what to do next. Fires when a session starts or the learner asks for a plan. Plan from missions and frontier to a target the learner hears the reason for, then conduct one lesson toward a single tangible win — review, present, practice, close.
---

# Lesson planning and conducting

One session, one node, one demonstrable win. Planning turns Missions and
frontier into a target; conducting follows the review, present, practice,
close shape.

Reads: `mission(scope?)`, `preferences()`, `competency(scope)`,
`coverage(scope)`, `frontier(scope?)`, `route(node)`, `trail(node)` for
each candidate.

## Planning

1. `(query)` Coverage. If the scope has essentially no trail, suggest
   calibration before planning; a frontier over pure priors is noise.

2. `(query)` `frontier` ranked across all Missions by learner-set
   priorities, each node's importance to each Mission, uncertainty, and
   staleness; or restricted to the learner's explicit request. Each
   candidate arrives with its estimate, uncertainty, staleness, route, and
   trail summary.

3. `(model)` Choose the target from the candidates and tell the learner why
   in one sentence ("X is the last thing between you and Y, and your
   evidence on it is three weeks old"). Evaluate the ranking rather than
   obeying it: the frontier guarantees prerequisite soundness, and the
   choice weighs Missions, recency, learner energy, and stated preference.
   The learner may override; teaching past a failed gate is allowed only
   after saying which prerequisites are shaky.

4. `(model)` Scope the session to a single tangible win on that node, sized
   to the learner's preferences. Open the node's Material as the Primary
   material; a node with no material invokes just-in-time drafting (the
   material-drafting Skill).

## Conducting

5. Retrieval opener. `(learner)` Answers two or three recall questions on
   prerequisite or prior nodes, chosen from `route(target)` weighted toward
   stale trails. Emit Observations for each. Done when the opener confirms
   the route or reveals a gap; a revealed gap re-plans to the gap node.

6. Present. `(model)` New content in small steps. Lead with a complete
   worked example when the trail shows no unaided success; otherwise start
   at the support level the trail justifies. Use the exact Patch content;
   cite it.

7. Guided practice. `(learner)` Works the frontier steps; demonstrate
   already-mastered steps briefly rather than making the learner grind
   them. `(model)` Gives feedback at the step just taken. Steer to roughly
   80% success: two consecutive unaided successes, advance or fade support;
   two consecutive failures, back up a step or drop to the prerequisite and
   say so.

8. Record as demonstrated. `(model)` Emit an Observation at the moment of
   each direct demonstration, exact node ids, native payload quoting the
   demonstration. Nothing for content merely presented.

9. Close. `(learner)` Attempts one unaided check on the target's criterion.
   `(model)` Proposes review cards for nodes with new evidence, then
   recounts to the learner exactly what evidence was recorded and what the
   next frontier looks like. Done when the learner has heard the record and
   the cards are accepted or declined.

Emits: Observations from steps 5, 7, 8, 9; card proposals; a session
transcript for post-close evaluation.

## Techniques

@../techniques/conducting.md

Also apply coverage-is-not-learning from
[evaluating](../techniques/evaluating.md).

@../techniques/index.md
