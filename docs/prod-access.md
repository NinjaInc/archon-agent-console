# Production access with `archon-prod`

`scripts/archon-prod.mjs` lets an agent on this server look at, redeploy and add stacks on a **production Docker host managed by Portainer**, without giving it a shell on that host.

It talks to Portainer's REST API. Portainer's own MCP server is *not* used: its README says it is unsupported and "not recommended for production environments".

## What it can and cannot do

| Command | Effect |
| --- | --- |
| `archon-prod status` | Environments, stacks and containers. Read-only. Environment values are never printed. |
| `archon-prod logs <container> [--tail N]` | Last N log lines (max 2000). Read-only. |
| `archon-prod redeploy <stack> [--yes]` | Pull the stack's git repo and images and recreate changed containers. Git stacks only. |
| `archon-prod create-stack <name> --repo <https-url> [--ref ...] [--compose ...] [--env K=V ...] [--yes]` | Create a stack from a git repository. |
| `archon-prod trust [--yes]` | Show or pin the Portainer certificate fingerprint. |

There is **no** command to delete, stop, prune or run anything. A changing command without `--yes` only prints its plan. New stacks can only come from `https://` repositories under `allowedRepoPrefixes`, so a hostile instruction cannot deploy someone else's code. Every action is appended to `~/.local/state/archon-prod/audit.log` (no secrets).

## Setup

1. In Portainer: **My account → Access tokens → Add access token**. Ideally create a dedicated user for this (for example `archon-ai`) so the token can be revoked without affecting your own login.
2. On this server, from a normal terminal (not through a chat), save the token:
   ```bash
   mkdir -p ~/.config/archon-prod && chmod 700 ~/.config/archon-prod
   umask 077; cat > ~/.config/archon-prod/portainer.token     # paste the token, Enter, then Ctrl-D
   ```
3. Create `~/.config/archon-prod/config.json`:
   ```json
   {
     "url": "https://<portainer-host>:9443",
     "redeployAllow": ["*"],
     "allowedRepoPrefixes": ["https://github.com/<you>/"]
   }
   ```
   `redeployAllow` can list stack names instead of `*`. Set `"endpointId"` if Portainer manages more than one environment.
4. `archon-prod trust` shows the certificate fingerprint; compare it with Portainer (*Settings → SSL certificate*), then `archon-prod trust --yes` pins it. The tool refuses to send the token if the certificate ever changes.
5. `archon-prod status`.

The token and config are owner-only files. The tool refuses a token file that other users can read.

## Approvals

Add rules to `~/.claude/settings.json` so reading is free and every change asks first:

```json
{ "permissions": {
    "allow": ["Bash(archon-prod status:*)", "Bash(archon-prod logs:*)"],
    "ask":   ["Bash(archon-prod redeploy:*)", "Bash(archon-prod create-stack:*)", "Bash(archon-prod trust:*)"],
    "deny":  ["Read(~/.config/archon-prod/**)", "Bash(*portainer.token*)"]
} }
```

## Limits (be honest about them)

- The agent runs as the same Linux user that owns the token file. The rules above stop Claude's own tools reading it and make every change prompt, but they are guard rails, not a security boundary. If you want a hard boundary, give the token to a separate user and expose only the commands through a socket.
- The token is a Portainer user's token, so it is as powerful as that user. Use a limited Portainer user where your edition allows.
- Only stacks created from git can be redeployed this way.

Run the tool's tests with `npm run test:scripts`.
