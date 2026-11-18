# Archon Agent Console - Plan

Author: Josh Neufield (Archon Tech). Fork of CloudCLI UI (siteboon/claudecodeui) v1.37.9.
Branch: `feat/agy-passkey`. Fork: `NinjaInc/archon-agent-console` (see decision D1).

## 1. How the codebase is wired (findings)

**Providers.** `server/modules/providers/provider.registry.ts` holds a closed record
`Record<LLMProvider, IProvider>` with `claude | codex | cursor | opencode`. Each provider is a
directory under `providers/list/<id>/` with auth, models, sessions, session-synchronizer, MCP,
skills and a runtime class. The runtime is what powers *chat*: it drives an SDK/app-server,
streams normalized messages over the `/ws` websocket, and a synchronizer parses the CLI's own
on-disk session files into the sidebar. **There is no Gemini provider in this version** - upstream
already removed it, so there is nothing dead to remove on the server. I will still grep the
frontend for leftover Gemini UI in Phase 1.

**Shell/PTY.** `websocket/services/shell-websocket.service.ts` (`/shell`) spawns
`bash -c "<command>"` under `node-pty`. `buildShellCommand` maps `provider` -> command line
(`cursor-agent`, `codex`, `opencode`, else Claude). PTYs are keyed by `projectPath_sessionId` and
survive reconnects for 30 min with a replay buffer. The client sends `projectPath` and it is only
checked for being a directory - **it is not confined to any root** (to fix in Phase 4).

**Auth.** `modules/auth`: username/bcrypt password, single user, 7-day JWT in `localStorage`,
sent as `Authorization: Bearer`, or `?token=` for SSE and the websocket upgrade (token in URL).
`authenticateToken` guards most `/api/*` mounts. Observed gaps relevant to this project:
- `/api/agent` uses its own API-key auth, `/api/browser-use-mcp` its own local token - both
  must be audited (they can drive agents/browsers) and gated behind the session too.
- `IS_PLATFORM` mode bypasses auth entirely and uses the first DB user. Must be impossible to
  enable on this deployment (I will hard-fail at boot if `VITE_IS_PLATFORM`/platform is set while
  passkey mode is on).
- WebSocket `verifyClient` checks the token only, **no Origin check**.
- `app.use(cors(...))` is wide open (reflects any origin).
- `HOST` defaults to `0.0.0.0`.
- `/health` is public (fine, but must stay minimal).

**File API.** `file-tree` module. Roots come from `WORKSPACES_ROOT` (default `$HOME`). Project-
relative writes use `resolvePathInsideProject`, which is a **string prefix check with no
`realpath`** - a symlink inside a project can escape. Read-only roots additionally allow `/tmp`
and `~/.claude/projects`. `resolvePathUnderRoots` does it right (realpath both sides); I will route
the file-tree through realpath containment consistently and add tests.

**Frontend.** React/Vite under `src/modules/*`. Auth lives in `src/modules/auth` +
`src/shared/authToken.ts` + `src/shared/api.ts` (token header) + `shell/utils/socket.ts` and
`WebSocketContext.tsx` (token in the ws URL). Provider list is duplicated across ~20 files keyed
by the `LLMProvider` union.

## 2. Decisions (made without asking, per the rules)

- **D1 - Fork target.** `--org NinjaInc` failed: `NinjaInc` is a *user* account, not an org. Forked
  into the user account instead (`NinjaInc/archon-agent-console`). The PR targets `main` of that
  fork, never upstream.
- **D2 - agy integration = terminal tab, not chat provider.** A chat provider needs a runtime that
  streams structured events, a session-file parser for the sidebar, model/auth/MCP/skills
  providers, and the frontend provider union across ~20 files. agy's non-interactive mode prints
  nothing without a TTY and its on-disk session format is undocumented, so a chat adapter would be
  built on guesswork and would be a fragile screen-scrape. The shell service already runs agent
  CLIs in a node-pty (which is exactly the TTY agy requires) and already has a provider->command
  map. So: add `agy` as a *shell-only* agent, surfaced as an "Antigravity" tab, with the project
  directory as cwd. Cost: no structured chat history/sidebar sessions for agy. I will say so in the
  final report.
- **D3 - Passkey library:** `@simplewebauthn/server` + `@simplewebauthn/browser` (as specified).
- **D4 - Sessions:** server-side session table (random 256-bit id, stored as SHA-256 hash),
  cookie `__Host-` prefixed (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`), idle timeout
  (default 30 min, `SESSION_IDLE_MINUTES`) + absolute lifetime (12 h), revocable. JWT/localStorage
  path is removed. WebSocket auth reads the cookie on upgrade; `?token=` is dropped.
- **D5 - Persistence:** reuse the existing better-sqlite3 DB (new migration) for `passkeys`,
  `sessions`, `bootstrap_tokens`. No more `users.password_hash` use; the single-user concept is
  kept as an internal owner row so existing FKs keep working.
- **D6 - Platform/API-key paths:** `/api/agent` and `/api/browser-use-mcp` get the session guard
  unless the request is loopback AND carries its pre-existing secret (browser-use MCP is called by
  the local CLI subprocess). Decided per-route when audited; recorded below as done.
- **D7 - cloudflared** is not installed on this box. Per instructions I do not install system
  packages silently. I will write the systemd unit/config and verify what I can; the tunnel
  verification steps are listed as manual.

## 3. Phase approach

- **Phase 0:** fork, branch, toolchain check, this plan, baseline run on 127.0.0.1:3001.
- **Phase 1 (agy):** `agy` entry in shell command map (cwd = project, PTY already guaranteed),
  "Antigravity" tab in the frontend, settings/auth panel: writes `GEMINI_API_KEY` +
  `{"modelProvider":"gemini"}` to `~/.gemini/antigravity-cli/settings.json` (mode 0600, never
  logged, never returned to the client) and a button that opens `agy` login in the PTY so the
  OAuth URL flow works (shell service already detects/announces auth URLs). Strip leftover
  Gemini CLI UI.
- **Phase 2 (passkeys):** new `auth` internals: bootstrap token (printed on console or
  `BOOTSTRAP_TOKEN` env, 15 min expiry, single use, constant-time compare, stored hashed),
  WebAuthn register/login endpoints, challenge store with TTL, passkey list/revoke (cannot revoke
  the last passkey without confirmation flag), `npm run passkey:reset`, rate limiting
  (`express-rate-limit`), Origin check on websocket upgrade and on non-GET requests, CORS
  restricted to `APP_ORIGIN`. Frontend: replace login/setup forms with passkey UI; credentials
  settings tab.
- **Phase 3 (network):** bind `127.0.0.1` (refuse non-loopback `HOST` unless
  `ALLOW_NON_LOOPBACK=true`), `cloudflared` systemd unit + config template, Cloudflare Access
  steps/curl/terraform, `Cf-Access-Jwt-Assertion` verification with `jose` (remote JWKS,
  `iss`/`aud`/`exp`), enforced when `CF_ACCESS_REQUIRED=true` on HTTP and WS upgrade.
- **Phase 4 (hardening):** dedicated `archon` system user + systemd unit (NoNewPrivileges,
  ProtectSystem, etc.), `PROJECTS_ROOT` env wired into file tree and shell cwd with realpath
  containment, `.env.example`, worktree helper script, `/healthz`, logrotate config.
- **Phase 5 (verify):** node:test suites for the above + manual E2E checklist.

## 4. Known blockers / manual items (updated as I go)

- `cloudflared` missing; Cloudflare API credentials not available -> Access app + DNS are manual.
- Passkey registration/login needs a physical authenticator tap through the tunnel hostname.

## 5. Additions requested mid-run (2026-11-18)

- **R1 - agy must work, and Claude must be able to hand work to it.** Besides the Antigravity
  terminal tab (D2), ship `scripts/agy-pty` (author Josh Neufield, Archon Tech): runs
  `agy -p "<prompt>"` inside a pseudo-terminal and prints the result to stdout, so Claude Code's
  Bash tool can delegate ("ask agy to ...") despite agy printing nothing without a TTY.
- **R2 - see local git repos, images and Google Drive in the console.** Replace the single
  `WORKSPACES_ROOT` with `PROJECTS_ROOTS` (comma-separated; default `~/projects,~/src,~/drive`).
  The file explorer, shell cwd and project creation are all confined to these roots with
  realpath containment (Phase 4 tests cover traversal + symlinks per root). Repos under
  `~/projects/NinjaInc/*` are discoverable as projects; `~/drive` (rclone mirror: Outputs/Images,
  Documents, Media, Inbox, Backups) is browsable. Drive is a *mirror*: editing there only syncs
  when `drive-sync push` runs - the console does not run it automatically.

## 6. Outcome (updated at end of run)

Decisions made along the way (beyond section 2):
- **D8 - npm 12 install:** lockfile `resolved` URLs pointed at registry.npmmirror.com for 24 packages and npm 12 refuses
  that. Repointed to registry.npmjs.org (integrity hashes unchanged). Install scripts allow-listed only for
  bcrypt, better-sqlite3, node-pty, esbuild, sharp.
- **D9 - passkey sessions** also cover live sockets: open websockets/PTYs re-check the session every 15 s (no activity touch).
- **D10 - `/api/agent`** now requires a signed-in session in addition to its API key. `/api/browser-use-mcp` keeps its
  local-token auth and is exempt only from the Origin check.
- **D11 - platform mode** (auth bypass) is refused at startup.
- **D12 - file explorer:** project paths resolve through realpath; a project outside `PROJECTS_ROOTS` (e.g. `/home/dev`
  itself, which holds `~/.ssh`) is not browsable/writable. Default roots are `~/projects,~/src,~/drive`.
- **D13 - agy API key** lives in an owner-only file (`~/.cloudcli/agy.env`), not in agy's settings.json, and is injected
  only into agy PTYs. API only so far; no settings-screen control yet.
- **D14 - service install not applied on this box:** `deploy/install.sh` is written and syntax-checked but not run, because
  running as a dedicated `archon` user changes which repos and `claude`/`agy` logins the agents can see (needs your call).

Not done / not verifiable here: cloudflared and Cloudflare credentials are absent, so tunnel routing, Access policy,
passkey registration with a real authenticator and reboot persistence were not exercised end to end.

- **D15 - LAN bind (user decision, 2026-11-18):** cloudflared lives on another host (APP01), so the console must be reachable
  on this box's LAN address. `HOST` may now be one private RFC 1918 IPv4 that belongs to this machine, and only with
  `ALLOW_LAN_BIND=true`; `0.0.0.0`, `::`, hostnames and public addresses are still refused (`server/shared/bind-host.ts`, tested).
  Running live as a *user* systemd service (`~/.config/systemd/user/archon-agent-console.service`, linger on) under `dev`,
  bound to 192.168.1.84:3001, env in `~/.config/archon-agent-console/env` (0600). Cloudflare Access verification is OFF until the
  Access app exists. Plain-http LAN access cannot sign in (passkeys + `__Host-` cookie need https); use the tunnel hostname.
