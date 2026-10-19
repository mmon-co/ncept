# roleplay

Kind: `roleplay`, type `encounter`. Write the character's private `script` and the `scene` the learner sees. An ordinary opening is ungraded practice; to grade it, pose it in a Quiz Problem with `answer:{kind:"roleplay",material:{id,revision}}` and a checks or rubric grader.

JSON text in a string, not Markdown:

```json
{
  "title": "...",
  "scene": "learner-visible situation and task",
  "script": "private character instructions"
}
```

Text is nonblank. Optional `model` uses an existing model spec (`provider/model-id[:effort]`); omission pins the default model when opened. The Material envelope carries `about`; the body has no checks or about. The role sees only its script, scene and this run's transcript.
