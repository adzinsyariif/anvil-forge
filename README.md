# AnvilForge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/adzinsyariif/anvil-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/adzinsyariif/anvil-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for the make.fun bounty [“Build a GitHub-compatible git forge”](https://make.fun/bounty/github-core-clone-01).

AnvilForge is a GitHub-compatible git forge in a single Node.js process, written with the
standard library only — no dependencies, no `git` binary, no network at run time. It speaks
four surfaces over one shared in-memory state:

- **git smart HTTP** at `/<owner>/<repo>.git/…` — `info/refs`, `git-upload-pack`
  (protocol v2 with `ls-refs` and `fetch`, including shallow clones and deepen, plus a v0
  fallback) and `git-receive-pack` (v0 with report-status). The git object model — blobs,
  trees, commits, tags, packfile parsing/generation and delta resolution — is implemented
  from scratch on `node:crypto` SHA-1 and `node:zlib`.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, issues,
  comments, labels, pull requests, changed files and merges, with GitHub's status codes
  (201/404/405/409/422), `Link`-header pagination and bearer-token auth.
- **GraphQL v4** at `POST /api/graphql` — a small parser and executor covering the
  documents `gh` sends: viewer, repository fields, issues and pull requests, the create /
  close / merge mutations, Relay `node(id:)`, cursor pagination, the introspection probes
  and operation batching.
- **MCP** at `POST /mcp` — streamable HTTP with `server/discover` and the legacy
  `initialize` handshake, `tools/list` and `tools/call` for the repository, issue and
  pull-request tools.

Served state is deterministic: ids come from sequence counters and timestamps from a
logical clock, never from the wall clock or randomness.

## Run it

```sh
node main.ts
```

`main.ts` is the entry ↔ env lifecycle: it binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done` and exits 0 when the trial is
over. Without `MAKEFUN_ENV_URL` it exits 1 at once. Node 22.18+ (the platform runs
`node /bot/main.ts`); there is nothing to install.

## Layout

- `main.ts` — the lifecycle above (the starter's, plus one authored helper).
- `app.ts` — routing and auth wiring for every surface.
- `gitobj.ts` — the git object model: hashing, trees, commits, packfiles, deltas, reachability.
- `githttp.ts` — smart HTTP: advertisement, upload-pack (v2 + v0), receive-pack.
- `store.ts` — the forge's state and the operations every surface shares (issues, pulls, merges).
- `rest.ts` — the REST v3 resources.
- `graphql.ts` — the GraphQL parser, schema and executor.
- `mcp.ts` — the MCP endpoint and its tools.

## Licence

MIT (see `LICENSE`).
