# roleplay

Kind: `roleplay`, type `encounter`. Write the character's private `script` and the `scene` the learner sees. The learner talks with the character and finishes the encounter, and the transcript is graded against the checks.

JSON text in a string, not Markdown:

```json
{
  "title": "...",
  "scene": "learner-visible situation and task",
  "script": "private character instructions",
  "about": ["node-id"],
  "checks": [
    {
      "id": "...",
      "about": ["node-id"],
      "ask": "question about the learner response",
      "shown": "demonstration",
      "absent": "not taken up",
      "mistaken": { "short-name": "known wrong version" }
    }
  ]
}
```

Text is nonblank. About lists and check ids are unique; checks together cover exactly the Material about. `mistaken` is optional; names use lowercase letters, digits and hyphens. Optional `model` uses an existing model spec (`provider/model-id[:effort]`); omission pins the default model when opened. Text only; no extra keys, audio, pumps, hints or corrections.
