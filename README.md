# Common Concept open packages

Learn in [pi](https://pi.dev), or in [bb](https://getbb.app), from a Profile directory you own. Your chosen pi model does the tutoring and grading; local learning needs no Common Concept account, subscription or hosted deployment.

## Start in pi

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
- `/hub share` publishes one Mission's map and Materials at an unlisted Hub link that anyone can read and `/hub pull`. It needs a free account, not a subscription.
- `/ncept login` signs in through your browser. In `/author`, ask the tutor to publish and inspect its public-publication confirmation. Publishing needs a free account, not a subscription.
- `/ncept export-to-web` replaces web Main after confirmation, with every Mission. `/ncept import-from-web` replaces this local Profile after backing it up; use `/resume` to continue an imported conversation. These are deliberate imports, not automatic sync. Tool calls from the other host arrive as text, not re-execution.

Your model's own account and costs remain separate from Common Concept. See [the pi package guide](packages/pi/README.md) for commands, model requirements and workspace first use. pi is the official local front end; a local MCP server is not part of this release.

## Start in bb

```sh
bb plugin install npm:@mmon-co/ncept-bb
bb concept init ~/learn
```

Open **Learn** in bb's navigation rail and press **+ New Mission**. Each Lesson opens as its own thread, with pi as the tutor; Learn lists your Missions, their next stops and what is due for review. The Profile is the same directory, so `cd ~/learn && pi` continues in a terminal. See [the bb package guide](packages/bb/README.md).

## Packages

| Workspace | Package | Role |
| --- | --- | --- |
| `packages/core` | `@mmon-co/ncept-core` | Patches, observations, Profiles and the Theory interface |
| `packages/default-theory` | `@mmon-co/ncept-default-theory` | Learning algorithms, tutor Programs and Skills |
| `packages/local` | `@mmon-co/ncept-local` | File-backed Profile and Hub host library |
| `packages/pi` | `@mmon-co/ncept-pi` | Official pi front end |
| `packages/bb` | `@mmon-co/ncept-bb` | bb plugin over the pi front end: Learn, and a thread per Session |

This is a history-preserving mirror of the source monorepo's public packages.

## Licences

Core is Apache-2.0, so anything may read and write Patches and implement a Theory. The local host library, the pi front end and the bb plugin are MIT. The default Theory is under the [Functional Source License 1.1](packages/default-theory/LICENSE): use, change and redistribute it for anything except a commercial product or service that substitutes for it, which includes selling a Theory derived from it; each version becomes Apache-2.0 two years after it is made available. Learning with the local product, alone or with a paid teacher, is within every one of these.

## Develop and contribute

Install [Bun](https://bun.sh), then run `bun install`, `bun run typecheck` and `bun run test`. Typecheck builds the workspaces first; exports resolve to built JavaScript and declarations. These checks need no hosted deployment, account or secret.

Open a pull request here. A contribution is licensed under its package's licence, except that contributions to `packages/default-theory` are licensed under Apache-2.0. Maintainers import PR changes into the source monorepo for review, crediting the original authors. Accepted changes return with the next mirror update. Do not merge PRs directly into this mirror: its `main` is published from the source repository.
