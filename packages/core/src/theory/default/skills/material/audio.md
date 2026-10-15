# audio

Kind: `audio`.

Create a saved Audio Material without opening or focusing it. Supply 1–600 exact Unicode code points of text, a voice id selected from query {resource:'audio',op:'voices'}, and speed 0.7–1.2 (default 1.0). Only listed voices and accents are available. Create the clip before adding a Quiz or card. New managed ElevenLabs speech is charged at cost even with an own-key LLM; replay is free. Pending/failed invocations retain their receipt: retry the same invocation to read it, never make a paid retry. If managed credit is exhausted, offer Billing/top-up, not an ElevenLabs key or LLM BYOK bypass.

Create a audio Material; supply node or about, and list it without opening or focusing it. Use an existing audio/mpeg Attachment and metadata title, language, voiceName, voiceId, accent and speed (0.7–1.2). Audio has no text body. Editing a source does not change earlier card/run pins.

Edit a listed audio Material without changing focus. Use an existing audio/mpeg Attachment and metadata title, language, voiceName, voiceId, accent and speed (0.7–1.2). Audio has no text body. Editing a source does not change earlier card/run pins.

Remove a local audio Material. Use an existing audio/mpeg Attachment and metadata title, language, voiceName, voiceId, accent and speed (0.7–1.2). Audio has no text body. Editing a source does not change earlier card/run pins.

Explicitly open a listed audio Material for the learner. Use an existing audio/mpeg Attachment and metadata title, language, voiceName, voiceId, accent and speed (0.7–1.2). Audio has no text body. Editing a source does not change earlier card/run pins.
