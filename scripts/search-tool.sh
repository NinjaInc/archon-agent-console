#!/usr/bin/env bash
# search-tool - give Claude Code and/or Antigravity the read-only web_search and web_read tools.
# Author: Josh Neufield (Archon Tech)
#
#   scripts/search-tool.sh status
#   scripts/search-tool.sh on  [--project DIR | --user] [--agy]     Claude for one project (default: here) or every project; --agy adds Antigravity
#   scripts/search-tool.sh off [--project DIR | --user | --everywhere] [--agy]
#
# The tools come from scripts/search-mcp.mjs (run `npm run build` once; the search service is scripts/install-searxng.sh).
# They are small (two tools, about 600 tokens), but every tool a chat loads is paid for each time, so Claude's is switched on per
# project (Claude's "local" scope, keyed by the project's git repository, never committed). A new chat picks the change up.
# Claude already has its own web search; this adds a private, unmetered one, and gives Antigravity one.
set -euo pipefail

NAME="archon-web-search"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$HERE/search-mcp.mjs"
CLAUDE_JSON="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"

die() { echo "search-tool: $*" >&2; exit 1; }

show_status() {
  python3 - "$CLAUDE_JSON" "$NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except Exception:
    data = {}
print("Claude, every project (user scope):", "on" if name in (data.get("mcpServers") or {}) else "off")
on = sorted(p for p, v in (data.get("projects") or {}).items() if name in (v.get("mcpServers") or {}))
print("Claude, per project:", ", ".join(on) if on else "none")
PY
  if command -v agy >/dev/null 2>&1; then
    if timeout 20 agy mcp list 2>/dev/null | grep -q "$NAME"; then echo "Antigravity: on"; else echo "Antigravity: off"; fi
  else
    echo "Antigravity: agy not installed"
  fi
}

[ $# -ge 1 ] || { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }
action="$1"; shift
[ "$action" = status ] && { show_status; exit 0; }
[ "$action" = on ] || [ "$action" = off ] || die "unknown action '$action' (use status, on or off)"

scope=local; project="$PWD"; everywhere=0; agy=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) scope=user ;;
    --everywhere) everywhere=1 ;;
    --agy) agy=1 ;;
    --project) shift; [ $# -ge 1 ] || die "--project needs a folder"; project="$1" ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
[ "$everywhere" = 0 ] || [ "$action" = off ] || die "--everywhere only makes sense with off"

claude_in() { local dir="$1"; shift; ( cd "$dir" && claude "$@" ); }

if [ "$action" = on ]; then
  [ -f "$SERVER" ] || die "missing $SERVER"
  NODE="$(command -v node)" || die "node is not on PATH"
  if [ "$agy" = 1 ]; then
    command -v agy >/dev/null 2>&1 || die "agy is not on PATH"
    agy mcp add "$NAME" "$NODE" "$SERVER" >/dev/null
    echo "on:  Antigravity"
  fi
  if [ "$agy" = 0 ] || [ "$scope" = user ] || [ "$project" != "$PWD" ]; then
    command -v claude >/dev/null 2>&1 || die "claude is not on PATH"
    if [ "$scope" = user ]; then
      claude mcp remove "$NAME" --scope user >/dev/null 2>&1 || true
      claude mcp add --scope user "$NAME" -- "$NODE" "$SERVER" >/dev/null
      echo "on:  Claude, every project"
    else
      [ -d "$project" ] || die "project folder not found: $project"
      project="$(cd "$project" && pwd -P)"
      claude_in "$project" mcp remove "$NAME" --scope local >/dev/null 2>&1 || true
      claude_in "$project" mcp add --scope local "$NAME" -- "$NODE" "$SERVER" >/dev/null
      echo "on:  Claude, $project"
    fi
  fi
  echo "Start a new chat for it to take effect."
  exit 0
fi

# off
if [ "$agy" = 1 ]; then
  command -v agy >/dev/null 2>&1 || die "agy is not on PATH"
  agy mcp remove "$NAME" >/dev/null 2>&1 || true
  echo "off: Antigravity"
fi
if [ "$agy" = 0 ] || [ "$scope" = user ] || [ "$everywhere" = 1 ] || [ "$project" != "$PWD" ]; then
  command -v claude >/dev/null 2>&1 || die "claude is not on PATH"
  if [ "$everywhere" = 1 ]; then
    claude mcp remove "$NAME" --scope user >/dev/null 2>&1 || true
    while IFS= read -r dir; do
      [ -d "$dir" ] && claude_in "$dir" mcp remove "$NAME" --scope local >/dev/null 2>&1 || true
    done < <(python3 - "$CLAUDE_JSON" "$NAME" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
for path, block in (data.get("projects") or {}).items():
    if sys.argv[2] in (block.get("mcpServers") or {}):
        print(path)
PY
)
    echo "off: Claude, everywhere"
  elif [ "$scope" = user ]; then
    claude mcp remove "$NAME" --scope user >/dev/null 2>&1 || true
    echo "off: Claude, every project"
  else
    [ -d "$project" ] || die "project folder not found: $project"
    project="$(cd "$project" && pwd -P)"
    claude_in "$project" mcp remove "$NAME" --scope local >/dev/null 2>&1 || true
    echo "off: Claude, $project"
  fi
fi
