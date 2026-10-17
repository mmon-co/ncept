# audio

Kind: `audio`, type `clip`. Make speech with `material {kind:'audio', op:'command', command:'generate', input}`: `materialId`, `title`, `about`, `text` (1–600 code points, spoken exactly), `voiceId` from `query {resource:'audio', op:'voices'}`, and `speed` 0.7–1.2 (default 1.0). Make the clip before the Quiz or card that plays it.

New speech is charged at cost, even when the learner brings their own model key; replay is free. A pending or failed generation keeps its receipt: retry the same invocation to read it. If managed credit runs out, offer a Billing top-up.

An existing `audio/mpeg` Attachment can be added directly, with metadata `title`, `language`, `voiceName`, `voiceId`, `accent` and `speed`. Editing a clip doesn't change cards or runs that already play it.
