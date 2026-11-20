# Contributing to Archon Agent Console

Thanks for looking at the code. This is a private-use console that drives Claude Code and Antigravity, so changes are judged first on whether they keep it safe to leave on the internet.

## Set up

```bash
git clone https://github.com/NinjaInc/archon-agent-console && cd archon-agent-console
npm ci
npm run dev          # Vite + the server with hot reload
```

Node 22 or newer is required. Passkeys need https or `localhost`, so for local work run with `APP_ORIGIN=http://localhost:3001 RP_ID=localhost` (see the README).

## Before you open a pull request

```bash
npm run typecheck && npm run lint
npm test                # server tests (node:test)
npm run test:client     # client tests (vitest)
npm run test:scripts    # the helper scripts
```

All of them must pass. New behaviour needs a test, and security-relevant behaviour (paths, auth, spawned processes, anything that writes outside a project) needs a test that tries to break it.

## How the code is organised

- Server code lives in `server/modules/<feature>/` as a service (logic), routes (thin), a module (wiring) and `tests/`. Other modules are imported only through their `index.ts`.
- Client code lives in `src/modules/<feature>/` with the same barrel rule.
- The full rules are in `.agents/skills/backend-module-standards/` and `.agents/skills/frontend-module-standards/`. Lint enforces the import boundaries.

## Commits

Conventional commits with a lowercase subject, for example `feat(auth): readable setup tokens`. A husky hook runs lint-staged and commitlint, so a bad message is rejected locally.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Upstream

This is a fork of [CloudCLI UI](https://github.com/siteboon/claudecodeui). The README explains how to rebase on it and which files usually conflict. Generic fixes that are not specific to this fork are welcome upstream too.

## Optional: add a Co-Authored-By trailer automatically

`scripts/git-hooks/append-coauthor.sh` appends one `Co-Authored-By:` trailer to every commit message, and never twice (amend, rebase and a hand-typed trailer are all safe). The trailer text is read from a file, so no address lives in the repository:

```bash
mkdir -p ~/.config/archon-agent-console
printf 'Co-Authored-By: Your Name <you@example.com>\n' > ~/.config/archon-agent-console/coauthor-trailer
cp scripts/git-hooks/append-coauthor.sh ~/.config/archon-agent-console/
printf '#!/usr/bin/env sh\nsh ~/.config/archon-agent-console/append-coauthor.sh "$@"\n' > .husky/prepare-commit-msg
echo '.husky/prepare-commit-msg' >> .git/info/exclude   # keep this local hook out of git
```

Husky already routes `prepare-commit-msg` to `.husky/prepare-commit-msg`. Commit messages still have to pass commitlint (lowercase conventional subject, body lines under 100 characters).
