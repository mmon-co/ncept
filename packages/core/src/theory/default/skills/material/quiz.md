# quiz

Kind: `quizzes`.

Add a Quiz Material with node or about. Set input.show:true to open and present it on add; otherwise it is only listed.

Prepared prompt clip, separate from the private Problem body. Omit on edit to preserve; null removes.

For type "problem": JSON text in a string, not Markdown; audio is separate: supply top-level promptAudio or Material metadata "audio:prompt", never inside this body. Strict object shape: common required fields {"about":["node-id"],"prompt":"..."}, optional "presentation"; "answer" is {"kind":"choice","options":[{"id":"...","label":"...","correct":true|false,"error":"optional"}]} (at least two options, exactly one correct, unique ids), {"kind":"short"}, {"kind":"text"}, or {"kind":"applet","material":{"id":"applet-id","revision":{"identity":"patch-id","digest":"sha256:..."}},"setup":[{"command":"declared command","input":{}}],"read":"declared query"} (setup optional; the exact Notebook revision contains the applet); "grader" is {"by":"mechanical","accepted":["..."]} for short answers (choice uses its option keys), {"by":"tutor"|"learner","rubric":"optional"} for text or applet, or {"by":"checks","help":"pump"|"hint"|"correct","checks":[{"id":"...","about":["node-id"],"ask":"question about the response","shown":"what demonstrating it looks like","absent":"what not taking it up looks like","mistaken":{"short-name":"a known wrong version"},"hint":"optional","corrections":{"short-name":"optional, why wrong and the fix"}}],"pumps":[{"text":"asks the learner to take something up, never giving it away","checks":["check-id"]}]} for text or applet answers (unique ids; check abouts together are exactly the Problem about; pumps cover every check). Text checks are classified live as the learner writes; applet checks are judged only at submission, using the declared query value serialized as JSON (one match: its value; multiple: an array). Applet setup uses its own declared commands and input schemas, once per attempt; save state before returning from a setup command. Invalid answer/grader pairs are rejected. About must match the Material about Nodes. For type "set": JSON text in a string, not Markdown; strict object shape: {"title":"A concise name for this practice set","problems":["problem-id",...],"next":{"kind":"sequence"}}; "next" may instead be {"kind":"shuffle","seed":"..."|1}, {"kind":"until","correct":1}, {"kind":"prerequisites"}, or {"kind":"custom","js":"..."}. Problem ids must be distinct; until.correct must be a positive integer. prerequisites requires each Problem to be about exactly one Node in the checkpoint graph; it adaptively assesses prerequisites of the covered Nodes and may skip Problems.

Edit a listed quizzes Material without changing focus.

Remove a local quizzes Material.

Explicitly open a listed quizzes Material for the learner.
