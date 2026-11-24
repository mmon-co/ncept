import type { Skill } from "@mmon-co/ncept-core";

/** The mechanics Skill from docs/attachments/local-host-mechanics.md. */
export const mechanics: Skill = {
  name: "local-host",
  description: "A Material needs making, opening or reading back, or an outcome, change or reminder needs recording.",
  body: `The learner's work lives in the Profile directory; the Theory's tools, not you, decide what a record means.

## Materials

Create Materials with the \`material\` tool in whatever form fits: Markdown for reading, a file of tasks and answers for quizzes, a file of front/back pairs for cards, an HTML page or runnable program for an applet, or an audio clip. The tool records it in the learner's map and checks out a working copy under \`materials/<node>/\`—files written there directly are not Materials. Name each by what it teaches, reuse existing Materials on a Node before making another, and show one by giving its path (or running it when asked). Edits the learner makes in the working copy are their work—read them back as such.

## Grading and outcomes

Grade mechanically by running checks yourself where answers are mechanical; otherwise judge against the Node's criterion. Record results only through the Theory's record tools (\`record_material_attempt\`, \`record_demonstration\`, \`record_retrieval_opener\`, \`record_teaching\`, \`record_claim\`, \`record_retraction\`, \`close_recount\`) with the verbatim task and learner response—never write labels or edit the log directly.

- Use \`record_material_attempt\` for quiz items answered in chat (playground \`local\` for local files, plus item id, Node, task, response, outcome, and \`unaided\`).
- Use \`record_demonstration\` for ordinary conversational checks.
- A runner's existing result is returned without duplication; fix a wrong grade with \`evaluation_override\` and a reason. Fix any validation errors the Theory returns.

## Applets and read-back

Keep an applet's state in a file beside it, and read that file (or run its summary command) before describing the learner's position rather than relying on your last edit. Learner actions arrive in the next message or as file changes; an applet that needs attention writes its state file first, then notifies via terminal bell or the harness's notice.

## Notifications and wake-ups

You act only when the learner speaks or the harness runs you. For reminders or later follow-ups, use the harness's scheduler or write a note in \`reminders.md\` naming the Node and Session to resume—never promise a message you cannot send.

## Changes

Mission, graph, and guidance changes are proposals: show the diff as a readable file and ask approval through the harness's prompt. Apply them through the Theory's operations only after approval.
`,
};
