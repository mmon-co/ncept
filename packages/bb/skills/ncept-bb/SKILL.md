---
name: ncept-bb
description: "Create a Common Concept learning Profile and bb project."
---

Use `bb concept init [dir]` (default ~/learn). `--machine <id-or-name>` selects its machine; without it, the current thread's machine or the server is used. Initialization saves pi's trust entry on that machine.

Start the project's first thread with pi. ncept-pi owns tutoring and Profile writes; the bb extension opens each next Session in a sibling thread and each aside in a child. The outgoing conversation links to it.

For unpublished source on the bb server, run `bun packages/bb/scripts/source-install.ts <server-machine-id>` to build and install the durable main checkout, then pass its absolute packages/bb path as `--source` to init. This also selects sibling packages/pi. See the package README for first use.

`spawn --request-file <absolute-path>`, `associate --session <id>` and `carry --thread <id>` are transport commands used by the extension. Learn controls use the typed `open` and `thread` RPC in `src/contract.ts`; the package README describes their entries.
