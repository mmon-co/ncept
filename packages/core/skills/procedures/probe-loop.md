Shrink uncertainty where it blocks a decision, at the lowest evidence cost
that works. Reads: `probes(scope)`, `competency(scope)`, `items(node)`,
`trail(node)`.

1. `(query)` `probes(scope)`: nodes ranked by uncertainty weighted by
   topological value and staleness.
2. `(model)` Agree a budget with the learner: question count, and that they
   may stop early. Ask their own sense of what they know; it is experience,
   and it orders the probes.
3. Loop until step 4 stops it:
   - `(model)` Pick the next probe from the ranking. Use an authored item
     from `items(node)`; an empty bank invokes quiz authoring below.
   - Emit the Quiz. `(learner)` Answers, optionally with a comment.
   - Grade: a commentless keyed choice grades mechanically through its
     option's interpretation. A comment or free response goes through
     evaluate below.
   - Surprise in either direction: climb the format ladder for that region
     before moving on.
4. Stop on: budget spent; the region's uncertainty below the theory's
   stopping threshold; the learner ends it. Every stop is legitimate.
5. `(query)` Refold. `(model)` Show the updated map in plain terms: solid,
   shaky, untouched, and what the next lesson would be.
