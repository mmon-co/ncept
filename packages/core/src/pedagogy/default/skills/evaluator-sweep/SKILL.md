---
name: evaluator-sweep
description: A transcript segment contains unrecorded posed attempts or unattached claims, or a Patch revision has pending record homes. The host starts this background pass; it is not a prerequisite for close or in-scope evidence.
facet: position
entry: [system]
---

# Evaluator sweep

The host supplies the unswept transcript segment, its stable attempt identities, existing Records, the complete current capability catalog, and exact graph revision key. It serializes appends, preserves invocation identities on retry, and advances its segment cursor only after successful work. Deduplicate by attempt identity, not by Node: two distinct attempts on one Node are both evidence. Never duplicate a task component's Record.

1. Read existing `trail(node)` and `memory(node)` as needed. Inspect the segment for posed steps attempted but missed inline, including out-of-scope Nodes. Mere mention or spontaneous correct remarks are not tasks. For each missing attempt use `record_demonstration` with `grader: tutor`; quote task/response verbatim and preserve help received. No structural inference of failures.
2. Use `record_claim` only for unrecorded self-reports. For each active claim needing attachment, compare its text with current capability statements; call `attach_claim({record, nodes, revision})`. Attach by content, never by Edges. `nodes: []` is an explicit judgment that it currently has no home.
3. Call `refine_records({revision})`. The real revision pass sends only active pending demonstrations to content-based re-homing; retained UUIDs keep their Records. It also attaches the complete current Record-string batches to Node memory, including out-of-scope work. A failed save is retryable from a fresh snapshot. Summary compaction is the host's opaque memory job, never evidence.
4. Read `warnings(scope?)` for homeless Records and other facts. Do not invent Nodes or fire a repair; leave cited facts for the next planning read.

Done when the segment's missing attempts/claims are recorded, claim homes are explicit and pending revision work is resolved. A close recount and inline state remain valid even while this pass waits or retries. There is no generated progress narrative at close.

## Evaluate

@procedures/evaluate.md
