# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/1088766-sketch/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/1088766-sketch/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in pure Node — REST v3 + GraphQL v4 subset, an
MCP endpoint, and git smart-HTTP (clone / fetch / push, including shallow
clones), with zero runtime dependencies.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge"
bounty, $500 in USDC.

## What it implements

- **REST API v3 subset** — users, organizations, repositories, issues,
  labels, pull requests, collaborators, search, and `/api/v3/meta`.
- **GraphQL API v4 subset** — queries, mutations, and schema introspection
  for the repository / issue / pull-request surface.
- **MCP endpoint** — 13 tools for agent access (repository, issue and
  pull-request operations).
- **git smart-HTTP** — protocol v2 with sideband progress, packfile
  negotiation, and shallow-clone semantics (`--depth` / deepen).

## Running

The server entry is `app.ts`; `main.ts` is the make.fun lifecycle wrapper.
With Node 22+ (type stripping):

```sh
node main.ts
```

Configuration is via environment variables (port and API token); see the
source for details.
