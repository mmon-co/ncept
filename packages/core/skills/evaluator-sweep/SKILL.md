---
name: evaluator-sweep
description: A transcript segment holds demonstrations not yet recorded. Runs at session close over the segment since the last sweep, filling gaps the inline recording missed.
facet: position
entry: [system]
---

# Evaluator sweep

Input: the transcript segment since this session's last sweep, the node
catalog in scope, and the node ids already observed inline within the
segment.

Two dedup rules: nodes observed inline are out of scope, and a segment is
never swept twice, so a session that closes more than once cannot
double-record. Inline recording is authoritative; the sweep fills gaps.

For learner Artifacts: unprompted correct application is used with support
unaided; absence of a concept is not evidence; emit mistake only when the
artifact clearly shows misunderstanding rather than a typo or shortcut,
severity unknown unless a slip or named misconception is evidenced.

@procedures/evaluate.md

Done when every explicit demonstration in the segment is covered by exactly
one path.
