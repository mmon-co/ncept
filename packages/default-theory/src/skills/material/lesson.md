# lesson

When a short Lesson clears and there is time and attention left, carry on into the next Lesson. When it makes sense to stop, recount what the learner did and end the Session even if its Lesson is unfinished.

1. **Read the Lesson:** the current Lesson in context, its focus Nodes, their criteria, guidance, memory, trail, and existing Materials (`items`). If the Mission names a measure, also read the next milestone's trail for prior attempts and what broke. If an adopted Patch's Materials are already open, wait for the learner.

2. **When starting a Lesson,** recheck prerequisites marked `fadingPrerequisiteOfHere` with fresh problems before building on them, without waiting to be asked (see [review.md](review.md)). Then open the work the focus Nodes' guidance names and set completion.
   - **Retrieval opener:** if no fading-prerequisite recheck was needed and the focus Nodes have prior prerequisites with Records (and no authored first action or conjectured-measure opener supersedes it), open with a quick retrieval prompt on a prerequisite or recent Node instead of a recap, recording the learner's attempt via `retrieval-opener`.
   - **Memory work:** add the cards in one step, open them, and set each Node's `pedagogy:completion` query to its card recalls.
   - **Real-world step:** open a brief Material covering what to do, what it serves (its dependents), what done looks like, and any useful prep (drafting, rehearsing a conversation). Set `pedagogy:completion` to the evidence its criterion requires; the work itself is the check (record reports per `records`), and leave a return reminder through the host's mechanics.
   - **Exercise-based work:** add teaching Material and one assessment set of short, single-question tasks, setting `pedagogy:completion` for the focus Nodes to their criteria. Link the assessment set from the end of the teaching reading using the host's format so the learner opens it from there, and open only that reading.
   - **Conjectured Mission with a measure:** open an unaided attempt at the measure first and hold teaching until it ends—the milestone's short task trimmed to what the focus Nodes serve, recorded on the milestone Node with its conditions. Then build teaching and practice around what broke, skipping what the attempt already showed.

3. **Teach as the Mission's and Nodes' guidance directs,** following its sequence. Work other due Nodes or queue a Problem when it serves the Lesson. Revise the chart lightly when teaching shows it wrong (a missing prerequisite, a criterion or completion query that misses the intent, a Node split, or the Mission's method); switch to Chart only when the revision would pull the sitting off teaching. Use `record_missing_capability` for noting a gap without stopping.

4. **When a run ends unmet:** read the results, teach what was missed, and add fresh assessment items against the same checklist (rerun an existing set only if it generates new instances). Use `record_missing_capability` for an error fitting no Node; recheck a failing prerequisite in chat and leave a collapsed prerequisite to the check-in for a future Lesson.

5. **When the measure hasn't moved** across Lessons since the Mission's method was set, the method failed: propose a Mission revision replacing it while recording what the old method did to the measure. Involve the learner as far as their saved preference asks; otherwise state in a sentence what's changing and why.

**Cheat sheet & references:** Lessons are rarely revisited; references are. Maintain one cheat-sheet Document per Patch (with a glossary where the domain has its own terms, adding each term once the learner can use it). The first Lesson using a Node's `pedagogy:resources` adds it to a references Material with locators for its Nodes.
