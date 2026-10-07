---
name: charting
description: A proposed pursuit has no adequate graph content. Design the learning backward from the learner's goal, choosing how to teach before what to chart, then write the missing content, reusing what fits. Existing content that misfits needs realignment instead. The learner must start this editing activity.
facet: chart
entry: [learner]
---

# Charting

Design the learning from the goal backward, as a teacher who had never seen this system would, and work it out with the learner in conversation. The graph records the design; it does not suggest it. Do not chart what a typical course on the subject would cover unless the design arrives there.

## Grill

Start from `mission(scope?)` and the saved preferences supplied with this conversation; don't re-ask. Work through steps 1–6 in waves of at most three questions. Give each question options and a default, say roughly how many waves remain, and let the learner answer before continuing. The defaults are your judgments, especially the recommendations in the method step. For “do you already know …?” questions, give your best guess, leaning toward not known: a wrong “known” skips a needed lesson; a wrong “not known” costs a lesson that starts ticked. Treat the learner's answers about current ability as probably-known claims.

1. **Performances.** Restate what the learner wants to do in the world: read a particular text, hold a conversation, build or prove a particular thing. Ask what it is for, what they already know, and what is out of scope until each performance is concrete. Say where performances share a foundation.
2. **Evidence.** For each performance, decide what the learner would do to show it: the demonstration a check will pose. Fix this before content; content no demonstration needs is not in the design.
3. **Method.** Ask which ways of learning fit this goal as stated, not how the subject is usually taught. Look across domains: an approach built for another subject or kind of learner may fit better, and you can adapt it to a subject nobody has taught that way. Offer two or three high-level approaches with your opinion of each, their pros and cons for this learner, and a default recommendation. A method the learner already prefers, or an existing course or text they like, is a legitimate choice; design around it.
4. **Blockers.** Start from the terminal performances. For each, ask whether it can be mastered in one lesson once its blockers are cleared. If not, why not? A “why not” is a missing capability (a child Node), more volume (a tiered Node, such as top 50 then top 100 words, with an ordinary necessity Edge), or more consolidation time (a threshold, such as 60 then 90 wpm). Ask whether each actually blocks this learner; recurse until the learner already has it or the remaining Node is lesson-sized. A Node is at most one Session's teaching and demonstration, including its parent integration. Its grain is one check; use `lesson:<name>` Graph tags to group small Nodes taught together.
5. **Practice.** Practice belongs to Materials, not Nodes. Cards and problem sets serve the Nodes they practise; volume belongs in tiered Nodes, which those Materials serve. Charting doesn't author Materials; the lesson that introduces a Node does.
6. **Branch points.** Ask about choices only the learner can settle—breadth, modality, depth, and the like—and say what each answer changes.

## Research and draft

After choosing the method, research outside resources that fit it: existing courses, textbooks, primers and videos. Compare their pros and cons for this learner, then propose a mix. Put each chosen resource on the Nodes it serves as `pedagogy:resources`, a list of `{ title, url?, why }`; `why` says how it fits this learner. Fetch every included URL with `fetch_page` in this Session (for YouTube, fetch the transcript). A resource known from memory, such as a book, gets no URL. Charting does no Node-content work; the lesson that first uses a resource makes its References entry.

Drafting is transcription: the grilling decided the structure; the draft adds resolution—criteria, Edges, tags and resources—beyond what the discussion reached. Carry settled choices into the draft unchanged; batch the transcription without re-grilling them. Before writing, use the host's content query to find existing Nodes for parts of the design. `coverage(scope?)` is evidence absence, not a search for missing topics. Reuse a useful existing Node even when its trail is empty.

Chart breadth-first. Chart every section and milestone, then take the first section down to lesson-sized Nodes. Leave Nodes below later sections coarse with `pedagogy:elaborate: true`; the path shows a `Chart §n` stop before each. Section milestones are integration checks, with `pedagogy:elaborate: false`. When a learner's answer says they already have a capability, put their answer verbatim in `edit_graph_draft`'s `claim` for its matching draft Node; approval records and trusts it as probably known. Use `pedagogy:milestone: true` on section-ending capabilities; the Mission's targets are its final milestones. Use numeric `pedagogy:sequence` to break dependency-order ties. Group Nodes taught well together with `lesson:<name>` Graph tags: siblings to tell apart, or a step and its immediate use. A milestone stays alone. The theory derives the numbered path from the graph; do not author another syllabus structure.

In the learner-approved edit session, write the design:

@procedures/graph-authoring.md

Once the draft exists, present it in conversation and ask targeted questions: “Are these right? Is anything here something you don't care about or already know?” Map notes arrive with the learner's turn. Answer each note, turning it into draft edits or claim entries, and review the changed draft with the learner. Wait for the learner's reply and apply any changes before proposing the Mission.

Once concrete target identities and the reviewed graph pass the host's validation, propose the Mission through its Confirmation affordance; it includes the Session's persisted draft automatically, with matching draft targets. Give the Mission a concise `shortName`, keep the complete want as its `statement`, and copy the learner's own words for a new or moved goal into `learnerGoal`. If new observations prompted the graph change, cite them in the draft's `summary` edit with `cites`. Include both in the Confirmation; the learner can ask to revise the name before accepting it. If the learner asks to change the name while a Confirmation is pending, replace it through the same `propose_mission` path with `supersedes` set to the pending Confirmation id. If an existing goal moved, keep its Mission and View identities and cite the current Change in `revises`, with the new targets and the edited draft in that one Confirmation. Use a new Mission for a second goal. A new Mission has no `supersedes` or `revises`; include either only when its matching pending Confirmation or current Change actually exists. A goal remains prospective until approval; do not write a Mission to nonexistent Nodes. Read `mission` and `coverage` after approval. If the accepted Confirmation adds Nodes, re-home claims that now have a home (`attach_claim` says how).

After the Mission is accepted, the host shows the path and **Begin lesson n**. Say in one line why that lesson comes first. Do not offer probing. The probing Skill stays learner-invoked until [[projects/concept/issues/assess-after-charting-with-an-open-prompt]] replaces it. For claims about Nodes already accepted, use `record_claim` and attach them to the current Node(s) whose capability statements match; charting text alone is not a demonstration.

When work ends with a change of scope, offer the next Skill through `propose_skill` with `scope` set to `target`, `view` or `nodes` and `destination: { kind: new-session, mode: handoff, focus: ... }`. Use `side` when the learner wants to keep this Session open. The focus tells the harness what the carried summary should preserve.
