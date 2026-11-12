# @mmon-co/ncept-pi

The official pi learning front end over the MIT-licensed [local Profile host](../local/README.md). Your Profile is an ordinary directory; pi's accounts, models, theme, keybindings and global extensions stay yours. Coding projects do not load this package.

## Start learning

Install [pi](https://pi.dev), then:

```sh
npx @mmon-co/ncept-pi init ~/learn
cd ~/learn
pi
```

Accept pi's one-time project trust prompt. The dashboard above the editor shows Missions, next stops and due review, and clears when you speak. A fresh conversation is a chat Session.

- `/learn <goal>` charts what you want to learn. `/learn` offers Missions and their next stops; `/learn <mission-id>` opens a particular Mission.
- `/review` opens the due review batch; `/author [goal]` opens an authoring Session.
- `/missions` shows the dashboard again.
- `/hub pull <release-url or patch@version>` adopts a release without an account. You can also paste an address and ask the tutor to pull it.
- `/ncept login` signs in once through the browser; `/ncept logout` removes the saved Common Concept credential. These are separate from pi's model accounts.
- In authoring, ask the tutor to publish: its `hub` tool packages the current personal Patch, bases and Materials and confirms public publication. Publishing needs a free Common Concept account, not a subscription.
- `/ncept export-to-web` replaces web Main with this Profile after confirmation (and, if needed, choosing the Missions that fit the web allowance).
- `/ncept import-from-web` replaces this Profile after confirmation, preserving the old project in the host's backup directory. pi project settings are restored; `/resume` can continue imported Sessions.

Every conversation is pi's own JSONL under `sessions/`. `/resume` continues one, `/tree` selects its branch, and `/new` starts a fresh chat. Host mode switches open next or aside pi Sessions with the Theory's declared carry. Observations, Mission progress, saved Materials and trusted Session associations live in the Profile and travel with its exchange archive. A session pi keeps elsewhere (`--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or a front end such as bb's pi bridge) is mirrored into `sessions/`, so the Profile still carries every transcript.

The mode's native tools, context and Skills replace pi's coding prompt every turn. Global `AGENTS.md` and coding Skills are excluded. Existing web/search tools remain available in modes mounting `web`, and shell/file-writing tools in modes mounting `bash`. Tool selection is a tutor capability boundary, not an operating-system sandbox: pi and its extensions still have your OS permissions.

Models and grading use the model currently selected in pi, through pi's provider/auth runtime. The selected model must support tool calls and structured judgments. No Common Concept account, token limit, hosted deployment or subscription is needed for local learning.

## Front ends over this extension

A front end layered over pi can own where Sessions open, a new window or thread per Session say, through pi's shared extension bus. When a Session opens while the current pi session already holds a conversation, the extension emits `ncept:open-session` with the opened Session, its kickoff message, its hidden carry and whether it is aside; a listener that calls `claim` opens it itself, and the current pi session stays as it is. In the fresh pi session, the front end emits `ncept:adopt-session` with the Session and carry before the first prompt. The channels and payload types are exported from `@mmon-co/ncept-pi/events`.

## Development first use

From a repository checkout:

```sh
bun install
bun run --cwd packages/pi build
bun packages/pi/scripts/first-use.ts /tmp/my-ncept-profile
cd /tmp/my-ncept-profile && pi
```

The setup script requires an unused directory and points the project package at this checkout instead of the unpublished npm package. It creates an empty Profile, no account or seed; pi uses your existing model authentication. It does not change your global pi settings or deploy a service.

```sh
bun test packages/pi/test/pi-wiring.test.ts
```

The SDK wiring smoke uses a scripted model with real host tools and pi Session files; it makes no paid or network requests.

For a checkout-owned hosted endpoint, set `NCEPT_HUB_URL` to its Application base URL (including `/ncept`) before starting pi. `NCEPT_CREDENTIALS_FILE` selects an isolated credential file outside the Profile; login and logout use the same file. Omit both for the public product. OAuth uses pi's public CIMD identity, PKCE and the `patches publish learn` scopes; it does not require the issuer to enable dynamic registration.
