---
name: lesson
description: Teach and assess a Lesson through Materials; use conversation for questions and Material-event exceptions. A Review checks its frozen batch, then corrects misses. Loaded automatically in Lesson mode.
---

# Lesson

A Review uses the Session entry's frozen Node batch and the Review opening below. A numbered Lesson promises its fixed checklist, not every Node its Materials mention. Demonstrations of other Nodes still count to those Nodes.

1. Read the Session's Lesson in `theory {name:'mission',input}`, then its criteria, Edges and ordered `effectiveGuidance` through `read {resource:'graph',input}`. Read memory, trail and existing items for its Nodes. Follow the learner's chosen method and instructional order. Use prior learning to shape the Materials; only this Lesson's own Material records tick its checklist.
2. In the first turn, add a teaching Material and an assessment Material, showing the teaching one with `input.show:true`. Teaching and assessing are roles: one Material may do both, such as a game with progressively harder levels and retries. Use existing Materials before generating new ones. A Lesson with shipped Materials opens them without a tutor turn.
3. Put the worked example, minimal exposition and faded practice in the teaching Material, ordered by the learner's method. Cases first means attempts before the rule. Put unaided checks at the focus Nodes' criteria in the assessment, with enough independent Problems to demonstrate each Node. Use mechanical grading when the answer is mechanical. Include relevant outside-prerequisite retrieval where needed. Material attempts record themselves; reading is not a demonstration.
4. Let the learner work through the Materials without conversation. The host closes the Lesson when all focus Nodes demonstrate through its own Materials, then offers **Begin next lesson**. Do not use close-recount. Add review cards as ordinary flashcards Materials when useful, not as a closing requirement.

You run again only on a learner message or a Material event. Answer clarifying questions briefly. When a run ends with focus criteria unmet, inspect the results, teach the missed step briefly if needed, then add a fresh assessment Material. Keep the checklist fixed. Evaluation remains available for exceptional conversational evidence; it does not substitute for the Lesson's Material checks.

Milestone assessments elicit the capstone at its full unaided conditions. Prefer a few multi-Node tasks, with one check per actual criterion; give no hints or correctness feedback before the whole initial assessment is submitted. For text, use `answer:{"kind":"text"}`, `grader.by:"checks"` and `help:"pump"`. A milestone over claimed Nodes checks those claims with tasks not just taught. On failure, distinguish integration, component regression and missing capability in the exception conversation. Step integration conditions down then back up; record only actually attempted prerequisite failures. When practice is the blocker, say what to practise and why and offer the existing Review route. When the error traces to no Node, use `propose {op:'missing-capability',input}` to carry the concrete diagnosis into a Chart aside. After two or three scaffolded rounds without gain, offer that aside rather than an endless retry loop; the learner may continue. A failed assessment does not pass or automatically close the Lesson.

The first Lesson to use a resource in a Node's `pedagogy:resources` reads its saved source and adds locators through `material {kind:'references',op:'add',input}`. Fresh external research and graph edits belong in the declared Chart aside.

## Review opening

Read the frozen batch's criteria and Edges with `read {resource:'graph',input}`, and `theory {name:'memory',input:{node}}`, `theory {name:'trail',input:{node}}` and `theory {name:'items',input:{node}}`. Do not drop acquired Nodes or add prerequisites: this checks retention, not acquisition. Close teaching Documents before opening the Quiz; give no rules, hints, worked answers or correctness feedback until the whole Set is submitted.

Author 3–4 small realistic tasks for a batch of about nine Nodes, each eliciting several capabilities together; use fewer Problems for a smaller batch. Use `answer:{"kind":"text"}`, `grader.by:"checks"`, `help:"pump"`. Write exactly one check per batch Node, its `about` containing only that Node. Tie `ask`, `shown`, `absent` and named `mistaken` versions to visible evidence of its criterion in the task. Each Problem's `about`, and the Material tool's `about`, is the union of its checks. Pumps collectively elicit every check without revealing answers. Tally the distinct Nodes before opening: every batch Node must have a check; widen tasks rather than making a question per Node.

Add the Problems as Session Materials, then open one sequential Problem Set with their ids, a concise title and `"next":{"kind":"sequence"}`. At **That's the best I can do**, each check's verdict records that Node's attempt; set-aside or absent checks are misses. Do not double-record. Several checks from one response share evidence; the theory limits each Node to its first unaided review per day, with later attempts counting only as practice.

After the whole Quiz, read its results and `theory {name:'trail',input:{node}}`. Go through the results check by check: a miss is any check not shown, whatever its Node's standing in the trail, including one that shares a Problem with another miss. For each miss, give a one- or two-sentence corrective grounded in its criterion, then reopen the Document from the lesson that taught it with `material {kind:'document',op:'open',input:{teachingNode:node}}`, which retrieves its exact taught version across Sessions. A turn opens one Material: open the Document for the first miss, or the one that taught most of them, and name where the others were taught. If there is no teaching Document, say so and explain the missed step briefly rather than inventing a saved source. Due flashcards on these Nodes may follow as a short optional tail. Finish with `evaluation {op:'record',kind:'close-recount',input}` after every Node has a submitted verdict and misses have their corrective; do not require fresh acquisition, another mixed check or flashcards to close a Review. Closing an unfinished Quiz is a pause, never verdicts for unanswered checks.

## Quiz authoring

@procedures/quiz-authoring.md

## Material work

@procedures/material-work.md

When adopted guidance calls for a holistic scene check on a target Node, propose `propose {op:'mode',input}` into Scene using its declared aside route, that target entry and `full` carry; preserve this Lesson's scope and checklist. Only Scene runs and grades the encounter, so each attempt, a retry included, is its own proposal; Lesson speech never plays the role. When the learner chooses a different Lesson scope, propose `propose {op:'mode',input}` using the current registry's allowed route and a carry suited to the destination. For a Chart transition, use its declared aside route when available; a specific graph edit in the lesson's context can carry `full`. A mode procedure is not a Skill.
