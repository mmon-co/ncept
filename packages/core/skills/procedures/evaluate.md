Turn a posed attempt into one demonstration, not a general judgment of the learner. Identify the capability's exact Node; the host resolves provenance.

1. Identify the task and response verbatim. No attempt or a skip → no Record. A claim is separate: `record_claim({statement, prompt?, stance})`.
2. Check the task against the Node's statement. `unaided` was decided when posed; help before outcome changes it to false. Aided completion after that is part of the same attempt. A correct keyed choice cannot demonstrate a production capability just because the option was selected correctly.
3. Grade success/failure. A task component already recorded → read `trail` and do not duplicate it. Otherwise call `record_demonstration` with Node, outcome, unaided, grader (tutor for judged free work), task and response. An Artifact must be a requested task/section, not arbitrary attached prose.
4. Read `trail(node)` for the resulting rule. A failure applies only to this Node. If the record itself was mistaken, explain and use `record_retraction` followed by a corrected Record, never alter existing evidence.
