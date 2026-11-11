# mmon open packages

Learn in [pi](https://pi.dev) from a Profile directory you own. Your chosen pi model does the tutoring and grading; local learning needs no mmon account, subscription or hosted deployment.

## Start

Install pi, then:

```sh
npx @mmon-co/ncept-pi init ~/learn
cd ~/learn
pi
```

Trust the project and choose a model with tool-call support. Start with `/learn <what I want to learn>`. Inspect and confirm proposed map/Mission changes. The tutor can make readings, checks and other Materials as files under `materials/`; saved evidence and pi Session transcripts stay in this Profile.

- `/missions` shows your Missions and next stops; `/learn` offers a chooser.
- `/review` opens what is due; pi's `/resume` returns to a conversation.
- `/hub pull <release-page-url or patch-id@version>` adopts a public release without signing in.
- `/mmon login` signs in through your browser. In `/author`, ask the tutor to publish and inspect its public-publication confirmation. Publishing needs a free account, not a subscription.
- `/mmon export-to-web` replaces web Main after confirmation, subject to the free Mission allowance. `/mmon import-from-web` replaces this local Profile after backing it up; use `/resume` to continue an imported conversation. These are deliberate imports, not automatic sync. Tool calls from the other host arrive as text, not re-execution.

Your model's own account and costs remain separate from mmon. See [the pi package guide](packages/pi/README.md) for commands, model requirements and workspace first use. pi is the official local front end; a local MCP server is not part of this release.

## Packages

| Workspace | Package | Role |
| --- | --- | --- |
| `packages/core` | `@mmon-co/ncept-core` | Patches, observations, Profiles and the Theory interface |
| `packages/default-theory` | `@mmon-co/ncept-default-theory` | Learning algorithms, tutor Programs and Skills |
| `packages/local` | `@mmon-co/ncept-local` | File-backed Profile and Hub host library |
| `packages/pi` | `@mmon-co/ncept-pi` | Official pi front end |

MIT licensed. This is a history-preserving mirror of the source monorepo's open packages.

## Develop and contribute

Install [Bun](https://bun.sh), then run `bun install`, `bun run typecheck` and `bun run test`. Typecheck builds the workspaces first; exports resolve to built JavaScript and declarations. These checks need no hosted deployment, account or secret.

Open a pull request here. Maintainers import PR changes into the source monorepo for review, crediting the original authors. Accepted changes return with the next mirror update. Do not merge PRs directly into this mirror: its `main` is published from the source repository.
