# Contributing

Thanks for your interest in dev-savestate.

## Prerequisites

- Node.js 20 or later (see `.nvmrc`)
- Git

## Setup

Clone and install all workspace dependencies from the repo root:

```bash
git clone https://github.com/BFAlajid/dev-savestate.git
cd dev-savestate
npm install
```

## Build

```bash
npm run build --workspaces
```

## Test

```bash
npm test --workspaces
```

## Type check

```bash
npm run typecheck --workspaces
```

## Submitting a pull request

1. Fork the repo and create a feature branch off `main`.
2. Make your change with tests where applicable.
3. Ensure `npm run build --workspaces`, `npm run typecheck --workspaces`, and `npm test --workspaces` all pass.
4. Open a PR against `main` describing the change and motivation.

CI runs the same checks on Linux, macOS, and Windows across Node 20 and 22. A PR must be green before merge.
