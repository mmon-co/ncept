---
name: records
description: You're about to grade a learner's attempt, or a recorded task, outcome or claim seems wrong.
---

## Grading

Delegate chat capability checks to a grader (`watch` or `judge`) unless you're judging free work yourself. For `judge` and manual demonstrations, copy the posed task and just the learner's answer verbatim (answer any separate question in your reply). When recording by hand:

- **Lesson-opening retrieval:** record the learner's attempted answer to a lesson-opening retrieval prompt with `retrieval-opener` (`record_retrieval_opener`), never as a generic demonstration.
- **Unaided status** is fixed when you pose the task. Help on the checked capability before the outcome makes it aided; glossing unrelated unfamiliar words (stated to the learner and kept in the recorded task) doesn't. Never gloss the capability being checked.
- **Non-answers:** an explicit "I don't know" to a posed task is a `dont-know` demonstration; closing without answering records nothing.
- **Medium limits:** a keyed choice doesn't demonstrate production; a chat answer doesn't demonstrate a timed criterion—measure timing in a Material that reports it.
- **No duplicates:** read the trail first and don't record the same task component twice. Never infer prerequisite failures—only record a prerequisite if its own posed step was attempted.
- **Real-world steps:** record the step as the task and the learner's report verbatim as the response. Use `grader: learner` for their word, `tutor` when you inspected the artifact yourself (file, repo, URL), or `mechanical` for a runner's reading; `unaided` says whether they did it themselves. Their word suffices unless the criterion requires inspection—they are the authority on what they did. A step done before the Mission began is a claim; a state shown to still hold now is a demonstration observed now. The Node's completion query sets what evidence counts and how many.

## Standing & completion

- **Standing** (first qualifying rule wins): `demonstrated` when `pedagogy:completion` holds (a Node with no completion query is never demonstrated; aided attempts count only if selected); `probably-known` when an attached `knows` claim is newer than any failure on the Node; `unknown` otherwise. Only `demonstrated` and `probably-known` count as known for routing.
- **Retention** (separate from standing): replayed per learner day. Unaided success gives `Good` to direct prerequisites (at most once/day; failure never flows down). An unresolved failure stays due for Review until an unaided success regardless of the forgetting curve. Claims start a short schedule without covering prerequisites.
- **`pedagogy:completion`** on a Node or tag combines `{count, of}` clauses with `all`/`any`; predicates support `all`/`any`/`not`, `{field, is}`, and `{latest: {per: [fields], of: predicate}}` over `kind`, `node` (`"self"` or a Node ID), `at`, `material`, `item`, `outcome`, `unaided`, `grader`, `playground`, `scope`, `state`, `current`. Example (16 distinct latest unaided successes in a Set): `{"count":16,"of":{"all":[{"latest":{"per":["material","item"],"of":{"all":[{"field":"node","is":"self"},{"field":"material","is":{"playground":"quizzes","id":"set-verbs-1"}},{"field":"unaided","is":true}]}}},{"field":"outcome","is":"success"}]}}`

## Corrections

Read the Record's task, response, and standard first:

- **Standard dispute:** a learner disputing a correctly applied standard usually means the Material assumes a generic context their Mission only resembles, or they want a different bar. Settle the standard they want and propose a Mission revision adding it as assessment guidance.
- **Actual recording error** (wrong Node or outcome): confirm with the learner, retract, and re-record with the same task and response—or override a delegated/runner verdict instead. If replacement fails, tell them the retraction happened and retry.
- **"I've forgotten":** record a new claim; don't retract an earlier success.
- **Map complaint** (grain, order, scope): that's a checkpoint—propose Chart.
