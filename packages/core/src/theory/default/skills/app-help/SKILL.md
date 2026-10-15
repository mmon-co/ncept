---
name: app-help
description: The learner asks about Common Concept's appearance or behavior, how to use the application, or suspects a site problem. Read the relevant official Document before diagnosing a defect or suggesting a report.
---

# Application help

Use this Skill when the learner asks how the application looks or behaves, how to do something in it, or whether something is a problem. Load it afresh on each such turn: the host recomputes the recommendation candidates for the current turn, and an earlier loaded body is stale.

## Reference mode

The host supplies a complete index of Document-backed Nodes from the adopted official Common Concept Patch. Each entry has its Node identity, label, one-line summary and Document id. This index is independent of whether the learner used or heard about the affordance, and independent of this Session's Nodes.

Use `theory {name:'items',input:{node:'<Node identity>'}}` to read the relevant Document before explaining application behavior or calling it a defect. Product facts belong to Documents, not the index summaries. You may read a Document for reference even if its Node was used or previously recommended. A read is not an operation-use receipt and does not open the Document for the learner.

Distinguish expected behavior described by the Document from an actual defect. Do not suggest **Report a problem**, incognito, disabling extensions, clearing caches or other defect workarounds for behavior the Document explains. If the Document does not explain the reported behavior, ask for the detail needed to diagnose it before calling it a defect.

## Recommendation mode

The host supplies a separate candidate list containing only official affordances with a `pedagogy:raise-when` cue, no effective feature-use receipt anywhere in the Profile, and no Document link in tutor text on the selected open branch or closed-Session tutor memory. A candidate includes its raise condition and exact `documentUrl`. Use this list as the sole authority for unsolicited recommendations when the learner describes a matching workaround; never infer a recommendation from the reference index or from a Document. Never suggest, direct the learner to, or repeat an action absent from the fresh candidate list, even if the reference index or Document describes it. A direct request for instructions about an operation is reference help, not an unsolicited recommendation.

If a candidate closely matches, add one short aside to the answer already needed: name its current home, explain briefly why it helps, and link its Document as `[Document label](documentUrl)` using the supplied URL exactly. Keep the learner's actual work as the focus. If no candidate fits, say nothing.

Never recommend an affordance whose use or prior recommendation filtered it out. In particular, reference-mode access to a used or previously mentioned Document does not make it eligible. Omit it silently: no recap, offer, announcement of omission or endorsement of the workaround. Do not require a replacement affordance. An explicit request for help with a used or previously mentioned affordance is reference help, not permission to recommend it again.
