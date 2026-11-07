# mmon open packages

Portable learning data, the default learning Theory, and local hosts for coding agents. MIT licensed.

| Workspace                 | Package                   | Role                                                     |
| ------------------------- | ------------------------- | -------------------------------------------------------- |
| `packages/core`           | `@mmon-co/core`           | Patches, observations, Profiles and the Theory interface |
| `packages/default-theory` | `@mmon-co/default-theory` | Learning algorithms, tutor Programs and Skills           |
| `packages/local`          | `@mmon-co/local`          | File-backed Profile and Hub host library                 |
| `packages/pi`             | `@mmon-co/pi`             | Official pi front end                                    |
| `packages/local-mcp`      | `@mmon-co/mcp`            | Local stdio MCP server                                   |

See each package's README for its entry points. The local packages join this mirror as they land in the source repository.

## Develop

Install [Bun](https://bun.sh), then from this repository:

```sh
bun install
bun run typecheck
bun run test
```

The typecheck builds the workspaces first; exports resolve to their built JavaScript and declarations. Tests use Bun. No hosted deployment, account or secret is needed for these checks.

## Contribute

Open a pull request here. This repository is a history-preserving mirror of the open packages in mmon's source monorepo; maintainers import PR changes there for review, crediting the original authors. Accepted changes return with the next mirror update. Do not merge PRs directly into this mirror: its `main` is published from the source repository.
