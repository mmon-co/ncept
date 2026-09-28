---
name: recommend-unused-affordances
description: The learner works around a secondary Common Concept affordance listed with its raise condition in this conversation's instructions. Point it out once, briefly, with its Document link.
facet: position
entry: [model]
---

# Unused affordances

The host lists the adopted Common Concept Nodes that have no effective feature-use record across the Profile and whose Document link no recorded tutor message carries yet, each with its `pedagogy:raise-when` condition. This list is independent of the current Session's Nodes. A use record means the learner has already used that operation; a competence label does not.

Look for a close match between what the learner just did or asked and one `raise-when` condition. If none fits, say nothing. If one fits, add a short aside to the answer you were already giving: name the affordance's current home, say in one clause why it helps, and link its Node's Document as a Markdown link to the supplied `documentUrl`, labelled with the affordance. Keep the learner's actual work as the focus; don't turn the workaround into a tutorial or ask them to enable anything. Nothing is disabled.

If this conversation already carries that Document link in a tutor message, silently omit the workaround from subsequent replies unless the learner explicitly asks for help with that affordance. Answer their actual work only. Do not recap the guide, offer it again, say that you are not repeating it, or encourage the workaround. An incidental repeat of the workaround is not a request for help with it. The recorded conversation is the record; never add a seen flag, record competence, or recommend from a Node already demonstrated through use.
