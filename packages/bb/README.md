# @mmon-co/ncept-bb

Learn in [bb](https://getbb.app) from the [pi front end](../pi/README.md) and a Profile directory you own. Each next tutoring Session opens a sibling thread; an aside opens a child. The outgoing thread links to the new one.

## Start learning

Install the plugin, then create a Profile/project on its machine:

```sh
bb plugin install npm:@mmon-co/ncept-bb
bb concept init ~/learn
```

Start a thread in that project with the **pi** provider. Your pi models and authentication stay yours. Initialization adds both pi packages and saves the Profile's project-trust entry on its machine, since pi's RPC mode cannot ask for trust.

`--machine <id-or-name>` selects a machine explicitly; otherwise init uses the current thread's machine or, outside a thread, the server. Use an absolute directory or ~/ path. Existing Profiles are never overwritten.

## Source first use

From the main checkout on the bb server machine:

```sh
mise run deps
bun packages/bb/scripts/source-install.ts <server-machine-id>
bun packages/bb/scripts/first-use.ts /tmp/my-bb-profile <server-machine-id>
```

The last command prints a directly runnable thread-spawn command. It creates a disposable Profile/project with Count liberties and Recognize atari Missions, one due Review Node, and a scripted tutor. Say **Accept Lesson**, then in the new Lesson thread say **Open an aside**. The marker **blue pebble** travels with each handoff. No account, deployment, network model or paid draw is required. The script records provider contexts in the Profile's `bb-encounter-context.jsonl`.

From a worker checkout, run the panel-entry and association encounter inside the shared-install wrapper:

```sh
bun packages/bb/scripts/source-install.ts <server-machine-id> -- bun packages/bb/scripts/entry-encounter.ts /tmp/my-bb-entry-profile <server-machine-id>
```

The wrapper builds main before installing the candidate, then reinstalls main even when the command fails. It also re-homes checkout-backed Profile extensions and scripted providers to main. For a browser encounter, start `source-install.ts <server-machine-id> --until /tmp/my-unused-release-file` as a managed process, wait for **Candidate Learn ready**, then prepare first use and drive Learn. Close the browser and stop its threads, create the release file with `touch`, and wait for **Durable Learn source** before settling the worker. `source-install.ts <server-machine-id>` alone repairs an existing shared install. It uses the repository's main checkout, never a previously recorded worker source.

It starts from the same setup, opens the entry controls through RPC, creates a plain composer thread, restarts its process, and opens tutor handoffs and a kept aside. It stops its thread runtimes afterwards, retaining the Profile, project, `bb-first-use.json` target identity, provider contexts and `bb-entry-encounter.json` observations for the next UI encounter.

For a real learner using unpublished source, use `bb concept init ~/learn --source /absolute/main-checkout/packages/bb` instead; this selects sibling packages/pi too, without a seed or scripted tutor.

## Transport

The pi extension is inert outside bb. It claims ncept-pi's shared-bus handoff, passes a temporary host-local request file through `$BB_CLI concept spawn`, then removes the file. The plugin reuses the thread's project, environment and execution selection. Metadata records the Session and carry; provider environment contributions let the fresh pi process adopt them before its first prompt.

Carries above 24 KiB live in plugin-owned storage, referenced by thread metadata and fetched through `bb concept carry` on start. This avoids the OS environment-variable limit and bb's 256 KiB metadata limit. The handoff accepts up to 4 MiB of carry. Carry is hidden tutoring context, not a credential; bb provider diagnostics include contributed environment values.

## Learn entry API

Import `rpcContract`'s type from `src/contract.ts` for a typed plugin RPC client. `open({projectId, intent})` returns `{threadId, title}`. Entries are `continue` with `missionId`, `new-mission`, `review`, `tell-tutor` with `missionId` and `request`, `revise-lesson` with `missionId`, and `revise-route` with `missionId`. Continue returns the existing active Session's thread when it is known. `thread({projectId, session})` returns `{threadId: string | null}` for kept asides and history.

The selected project's source identifies the Profile and machine. Skip entries (`skip-lesson`, or `skip-to` with the stop identity from the Mission reading) resolve and write in the new tutoring pi process. `retire({projectId, missionId, outcome})`, with outcome `achieved` or `abandoned`, opens the writing local host on that machine and finishes the Mission under the Profile directory lock. It opens no thread. Other entry resolution and Session creation run in the tutoring pi process. A new Mission opens charting. Mission Continue resolves the next Lesson, review or charting stop; both Revise controls and Tell the tutor open a new Session. The learner's request remains the first user message. The title is refined from the resolved Session before its first turn.

Panel entries, tutor handoffs and plain pi threads all record their Session in plugin metadata and a Profile-scoped lookup. A process restart adopts the recorded Session. The Profile and its transcripts remain the local host's ordinary portable files.
