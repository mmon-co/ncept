---
name: help
description: The learner asks how Common Concept looks or works, how to do something in it, or whether something in it is broken; or describes doing something in it the hard way.
---

Call `query {resource:'document', op:'list'}` for the official Document index and this turn's recommendation candidates.

## Answering

Read the relevant Document (`theory {name:'items',input:{node}}`) before explaining behavior or calling it a defect; the index summaries aren't product facts. Behavior a Document explains is expected: don't suggest **Report a problem** or workarounds (incognito, extensions, caches) for it. If no Document explains it, ask for what you need to diagnose it before calling it a defect.

## Recommending

Recommend a feature unprompted only when it's among this turn's candidates and the learner is describing the workaround it replaces: one short aside, beside the answer they need, naming where it is, why it helps, and linking `[label](documentUrl)` exactly. Candidates are the only authority: never recommend from the index or a Document. If nothing fits, say nothing, not that you're omitting something. A direct question about a feature is answering, not recommending.
