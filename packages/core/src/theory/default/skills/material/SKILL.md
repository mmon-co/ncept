---
name: material
description: Material content needs a kind-specific format. Load only the resource for the kind being authored or corrected.
---

# Material formats

Use `material {op,kind,input,command?}`. Existing inputs go in `input`; type IDs remain `input.type`. Adding lists without opening; opening is explicit. Load a declared file with `skill {name:'material',resource:'quiz.md'}`.

- `document`, type `markdown`: [document.md](document.md)
- `quizzes`, types `problem` and `set`: [quiz.md](quiz.md)
- `roleplay`, type `encounter`: [roleplay.md](roleplay.md)
- `srs`, type `card`: [flashcards.md](flashcards.md)
- `applet`, type `applet`: [applet.md](applet.md)
- `references`, type `reference`: [references.md](references.md)
- `audio`, type `clip`: [audio.md](audio.md)
