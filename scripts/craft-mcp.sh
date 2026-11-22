#!/usr/bin/env bash
# craft-mcp - turn ArtCraft's MCP servers on only where you need them.
# Author: Josh Neufield (Archon Tech)
#
# Every MCP server a Claude session loads adds its tool list to the prompt. All thirteen ArtCraft apps together are
# about 860 tools, so registering them globally makes every chat start heavier and cost more even when you are only
# editing code. This tool registers them for ONE project (Claude's "local" scope, kept in ~/.claude.json and never
# committed) so only chats in that project pay for them. The apps themselves stay installed either way.
#
#   scripts/craft-mcp.sh status                                 what is installed and where it is switched on
#   scripts/craft-mcp.sh on  photo pdf [--project DIR]          switch on for a project (default: the current folder)
#   scripts/craft-mcp.sh on  all [--project DIR]                every installed app, for that project
#   scripts/craft-mcp.sh on  photo --user                       for every project (the expensive way; avoid)
#   scripts/craft-mcp.sh off photo [--project DIR | --user]     switch off again
#   scripts/craft-mcp.sh off all --everywhere                   remove from every project and from the user scope
#
# Switching on or off takes effect in NEW Claude sessions; a chat that is already open keeps what it started with.
# Install the apps themselves with scripts/install-craft-mcp.sh. Needs: claude, python3. No root.
set -euo pipefail

ROOT="${CRAFT_ROOT:-$HOME/.local/opt/artcraft}"
CLAUDE_JSON="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"

die() { echo "craft-mcp: $*" >&2; exit 1; }

installed_apps() {
  local d
  for d in "$ROOT"/*craft; do
    [ -e "$d" ] || continue
    basename "$d" | sed 's/craft$//'
  done
}

# The CLI that `mcp` runs, or nothing when the app is not installed.
cli_for() {
  local app="$1" cli
  cli="$(find "$ROOT/${app}craft/bin" -maxdepth 1 -name '*-cli' -type f 2>/dev/null | head -1)"
  [ -n "$cli" ] && [ -x "$cli" ] && printf '%s\n' "$cli"
}

# Where each app is switched on, read from Claude's own config (never printed beyond folder names).
show_status() {
  echo "installed under $ROOT:"
  local app any=0
  for app in $(installed_apps); do echo "  ${app}craft"; any=1; done
  [ "$any" = 1 ] || echo "  (none - run scripts/install-craft-mcp.sh)"
  python3 - "$CLAUDE_JSON" <<'PY'
import json, os, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
def crafts(block):
    return sorted(name for name in (block or {}) if name.endswith("craft"))
user = crafts(data.get("mcpServers"))
print("switched on for EVERY project (user scope):", ", ".join(user) if user else "none")
local = {p: crafts(v.get("mcpServers")) for p, v in (data.get("projects") or {}).items()}
local = {p: c for p, c in local.items() if c}
if local:
    print("switched on per project:")
    for path, names in sorted(local.items()):
        print(f"  {path}: {', '.join(names)}")
else:
    print("switched on per project: none")
PY
}

[ $# -ge 1 ] || { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }
action="$1"; shift

if [ "$action" = status ]; then show_status; exit 0; fi
[ "$action" = on ] || [ "$action" = off ] || die "unknown action '$action' (use status, on or off)"

apps=(); scope=local; project="$PWD"; everywhere=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) scope=user ;;
    --everywhere) everywhere=1 ;;
    --project) shift; [ $# -ge 1 ] || die "--project needs a folder"; project="$1" ;;
    -*) die "unknown option $1" ;;
    *) apps+=("$1") ;;
  esac
  shift
done
[ ${#apps[@]} -gt 0 ] || die "say which apps (for example: photo pdf) or 'all'"
if [ "${apps[0]}" = all ]; then
  [ ${#apps[@]} -eq 1 ] || die "'all' cannot be combined with app names"
  mapfile -t apps < <(installed_apps)
  [ ${#apps[@]} -gt 0 ] || die "no ArtCraft apps are installed under $ROOT"
fi
for app in "${apps[@]}"; do [[ "$app" =~ ^[a-z]{2,12}$ ]] || die "bad app name: $app"; done
[ "$everywhere" = 0 ] || [ "$action" = off ] || die "--everywhere only makes sense with off"

claude_in() { # claude_in DIR args... : run claude from inside a project folder so "local" scope means that folder
  local dir="$1"; shift
  ( cd "$dir" && claude "$@" )
}

if [ "$action" = on ]; then
  command -v claude >/dev/null 2>&1 || die "claude is not on PATH"
  if [ "$scope" = local ]; then
    [ -d "$project" ] || die "project folder not found: $project"
    project="$(cd "$project" && pwd -P)"
  fi
  for app in "${apps[@]}"; do
    cli="$(cli_for "$app")" || die "${app}craft is not installed (run scripts/install-craft-mcp.sh $app)"
    if [ "$scope" = user ]; then
      claude mcp remove "${app}craft" --scope user >/dev/null 2>&1 || true
      claude mcp add --scope user "${app}craft" -- "$cli" mcp >/dev/null
    else
      claude_in "$project" mcp remove "${app}craft" --scope local >/dev/null 2>&1 || true
      claude_in "$project" mcp add --scope local "${app}craft" -- "$cli" mcp >/dev/null
    fi
    echo "on:  ${app}craft  ($([ "$scope" = user ] && echo 'every project' || echo "$project"))"
  done
  echo "Start a new Claude session for it to take effect."
  exit 0
fi

# off
command -v claude >/dev/null 2>&1 || die "claude is not on PATH"
if [ "$everywhere" = 1 ]; then
  for app in "${apps[@]}"; do claude mcp remove "${app}craft" --scope user >/dev/null 2>&1 || true; done
  # Every project that has any of these switched on, according to Claude's own config.
  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    for app in "${apps[@]}"; do claude_in "$dir" mcp remove "${app}craft" --scope local >/dev/null 2>&1 || true; done
  done < <(python3 - "$CLAUDE_JSON" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
for path, block in (data.get("projects") or {}).items():
    if any(n.endswith("craft") for n in (block.get("mcpServers") or {})):
        print(path)
PY
)
  echo "off: ${apps[*]/%/craft} everywhere"
  exit 0
fi
if [ "$scope" = user ]; then
  for app in "${apps[@]}"; do claude mcp remove "${app}craft" --scope user >/dev/null 2>&1 || true; echo "off: ${app}craft (every project)"; done
else
  [ -d "$project" ] || die "project folder not found: $project"
  project="$(cd "$project" && pwd -P)"
  for app in "${apps[@]}"; do claude_in "$project" mcp remove "${app}craft" --scope local >/dev/null 2>&1 || true; echo "off: ${app}craft ($project)"; done
fi
