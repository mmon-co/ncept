# flashcards

Kind: `srs`.

Add review cards as an ordinary flashcards Material (kind srs), from front/back text and optional srs:confusable metadata. Supply node or about and either body or both front and back. Set input.show:true to open on add; otherwise it is only listed.

Markdown with front and back separated by a line containing ---

Text to prompt the learner with

Expected answer or explanation

Immutable audio/mpeg Attachment from material {kind:'audio',op:'command',command:'generate'} or an existing clip; omit to preserve, null to remove on edit.

Use {"srs:confusable": true} to interleave cards the learner may mix up.

Edit an owned SRS card's front/back, optional interleave category, or attached Nodes. Supply body or both front and back.

Remove an SRS card without deleting its grades.

Explicitly open an SRS card in this Session using a new Playground surface.
