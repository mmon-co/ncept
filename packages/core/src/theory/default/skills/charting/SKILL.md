---
name: charting
description: A proposed pursuit has no adequate graph content. Design the learning backward from the learner's goal, choosing how to teach before what to chart, then write the missing content, reusing what fits. Existing content that misfits needs realignment instead. The learner must start this editing activity.
facet: chart
entry: [learner]
---

# Charting

Design the learning from the goal backward, as a teacher who had never seen this system would, and work it out with the learner in conversation. The graph records the design; it does not suggest it. Do not chart what a typical course on the subject would cover unless the design arrives there.

1. **Performances.** Start from `mission(scope?)` and the saved preferences supplied with this conversation, so you don't re-ask. Restate what the learner wants to do as concrete performances in the world: reading a particular text, holding a conversation, building or proving a particular thing. Ask what it is for, what they already know, and what is out of scope, until each performance is concrete. Say where performances share a foundation.
2. **Evidence.** For each performance, decide what the learner would do to show it: the demonstration a check will pose. Fix this before any content; content no demonstration needs is not in the design.
3. **Method.** Ask which ways of learning fit this goal as stated, not how the subject is usually taught. Look across domains: an approach built for a different subject or kind of learner may fit this goal better than the subject's conventional course, and you can adapt it to a subject nobody has taught that way. Offer two or three high-level approaches with your opinion of each, their pros and cons in this learner's context, and a default recommendation. A method the learner already prefers, or an existing course or text they like, is a legitimate choice; design around it.
4. **Decompose.** Name the few strands the method implies (for example taking in, producing, supporting knowledge, fluency). For each performance ask what the learner must already be able to do to do it. An answer is either a prerequisite part, a separate capability, or the same whole task under simpler conditions: shorter, supported, slower, glossed. Recurse until each Node is something one Session can teach and close with its demonstration.
5. **Practice.** Parts that are practiced rather than understood (vocabulary, notation, facts, speed) become Nodes practiced with cards or problem sets. Size them from the goal itself where you can, by what the target text or task actually uses and how much of it each Node covers, not from a generic syllabus.
6. **Branch points.** Where the design forks on something only the learner knows (how broad, which modality matters, how deep), ask, and say what each answer changes.
7. **Depth.** Chart the terminal performances and one or two levels beneath them now. A Node left coarse, whose prerequisites are not charted yet, carries `pedagogy:elaborate: true`; it is elaborated when the route reaches it and the learner cannot already do it, by charting its prerequisites and Edges into it and setting the mark to `false`, never by replacing it. The Mission's View is its targets' dependency cone as the graph now stands, so new prerequisites join the Mission without revising it. Tell the learner which parts are left coarse.
8. **Reuse.** Before writing, use the host's content query to find existing Nodes for parts of the design. `coverage(scope?)` is evidence absence, not a search for missing topics. A useful existing Node is reused even when its trail is empty.

Give the Mission a concise `shortName` and keep the complete want as its `statement`. Include both in the Confirmation; the learner can ask to revise the name before accepting it. If the learner asks to change the name while a Confirmation is pending, replace it through the same **propose_mission** path with **supersedes** set to the pending Confirmation id. 9. In the learner-approved edit session, write the design:

@procedures/graph-authoring.md

10. Once concrete target identities and the proposed graph pass the host's validation, propose the Mission with that graph diff through its Confirmation affordance. If an existing goal moved, keep its Mission and View identities and cite the current Record in **revises**, with the new targets and **graphDiff** in that one Confirmation. Use a new Mission for a second goal. A goal remains prospective until approval; do not write a Mission to nonexistent Nodes. Read `mission` and `coverage` after approval. If the accepted Confirmation adds Nodes, re-home claims that now have a home (`attach_claim` says how).
11. Offer learner-started probing over the approved content (a whole-task check on a coarse Node may show its branch needs no elaboration), or leave a lesson target if enough evidence already exists. Never invoke probing yourself. Record genuine competence claims with `record_claim` verbatim and attach each to the current Node(s) whose capability statements match; charting text alone is not a demonstration.

When work ends with a change of scope, offer the next Skill through `propose_skill` with `scope` set to `target`, `view` or `nodes` and `destination: { kind: new-session, mode: handoff, focus: ... }`. Use `side` when the learner wants to keep this Session open. The focus tells the harness what the carried summary should preserve.
