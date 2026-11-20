#!/usr/bin/env bash
# setup-prod-claude - prepare the "Prod Claude" tab: a terminal in the web console that opens the Claude Code
# running on your production host, kept completely separate from this server's agents.
# Author: Josh Neufield (Archon Tech)
#
#   scripts/setup-prod-claude.sh <ssh-user> <host> [remote-command] [port]
#
#   ssh-user         the login on the production host that Claude Code runs as
#   host             its hostname or IP address
#   remote-command   what to start there (default: claude). Use the full path from `which claude` on that host.
#   port             SSH port (default 22)
#
# It creates, under ~/.config/archon-console/prod-claude (mode 0700):
#   id_ed25519 / id_ed25519.pub   a key used ONLY for this tab (no passphrase; protected by file permissions)
#   known_hosts                   the production host's SSH key, pinned (the tab refuses any other host key)
#   config.json                   host, user, command
# Then it prints the one line to add to ~/.ssh/authorized_keys on the production host. That line restricts the
# key so it can only start the remote command, never a shell, a file copy or a port forward.
#
# Nothing is changed on the production host by this script. Safe to re-run; an existing key is kept.
set -euo pipefail

user="${1:-}"; host="${2:-}"; remote="${3:-claude}"; port="${4:-22}"
dir="${PROD_CLAUDE_DIR:-$HOME/.config/archon-console/prod-claude}"

die() { echo "setup-prod-claude: $*" >&2; exit 1; }
[ -n "$user" ] && [ -n "$host" ] || die "usage: $0 <ssh-user> <host> [remote-command] [port]"
[[ "$user"   =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,31}$ ]]                       || die "bad ssh-user"
[[ "$host"   =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]       || die "bad host"
[[ "$remote" =~ ^[A-Za-z0-9_./~-]{1,120}$ && "$remote" != -* ]]           || die "remote-command must be one path or name"
[[ "$port"   =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "bad port"
for c in ssh ssh-keygen ssh-keyscan; do command -v "$c" >/dev/null 2>&1 || die "missing $c"; done

umask 077
mkdir -p "$dir"; chmod 700 "$dir"

if [ ! -f "$dir/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "archon-console prod-claude" -f "$dir/id_ed25519"
  echo "created a new key for this tab"
else
  echo "keeping the existing key"
fi

# Read the host's key once and pin it. This is trust on first use, so compare the fingerprint below with the
# one on the production host before relying on it.
scan="$(ssh-keyscan -T 8 -t ed25519 -p "$port" "$host" 2>/dev/null || true)"
[ -n "$scan" ] || die "could not read an ed25519 host key from $host:$port (is SSH reachable from here?)"
if [ "$port" = "22" ]; then printf '%s\n' "$scan" > "$dir/known_hosts"; else printf '%s\n' "$scan" | sed "s/^[^ ]*/[$host]:$port/" > "$dir/known_hosts"; fi
chmod 600 "$dir/known_hosts"

cat > "$dir/config.json" <<EOF
{
  "host": "$host",
  "user": "$user",
  "port": $port,
  "remoteCommand": "$remote",
  "label": "Prod Claude"
}
EOF
chmod 600 "$dir/config.json"

echo
echo "== 1. Check this fingerprint matches the production host (run on THAT host: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)"
ssh-keygen -lf "$dir/known_hosts"
echo
echo "== 2. Add this ONE line to ~/.ssh/authorized_keys of '$user' on the production host"
echo "restrict,pty,command=\"$remote\" $(cat "$dir/id_ed25519.pub")"
echo
echo "== 3. Reload the console. A red 'Prod Claude' tab appears next to the terminals."
echo "   (If it shows but will not connect: check the line above is on one line and '$remote' is the full path from 'which claude' on that host.)"
