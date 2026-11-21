#!/usr/bin/env bash
# agent-worktree - give each agent (claude, agy, ...) its own git worktree of a repo so two
# agents never edit the same working tree at once.
# Author: Josh Neufield (Archon Tech)
#
#   agent-worktree.sh create <repo-path> <agent> [base-ref]   new worktree + branch agent/<agent>/<stamp>
#   agent-worktree.sh list   <repo-path>
#   agent-worktree.sh remove <repo-path> <agent>               remove that agent's worktrees (branch kept)
#
# Worktrees live under $WORKTREE_ROOT (default: ~/projects/worktrees/<repo>/<agent>-<stamp>), which
# should sit inside PROJECTS_ROOTS so the console can browse them. Prints the worktree path.
set -euo pipefail

WORKTREE_ROOT="${WORKTREE_ROOT:-$HOME/projects/worktrees}"
cmd="${1:-}"; repo="${2:-}"; agent="${3:-}"

die() { echo "agent-worktree: $*" >&2; exit 1; }
[[ -n "$cmd" && -n "$repo" ]] || die "usage: $0 create|list|remove <repo> [agent] [base-ref]"
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $repo"
repo="$(git -C "$repo" rev-parse --show-toplevel)"
name="$(basename "$repo")"

valid_agent() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || die "agent must match [a-z0-9_-], got '$1'"; }

case "$cmd" in
  create)
    valid_agent "$agent"
    base="${4:-HEAD}"
    stamp="$(date +%Y%m%d-%H%M%S)"
    dir="$WORKTREE_ROOT/$name/$agent-$stamp"
    mkdir -p "$(dirname "$dir")"
    git -C "$repo" worktree add -b "agent/$agent/$stamp" "$dir" "$base" >&2
    echo "$dir"
    ;;
  list)
    git -C "$repo" worktree list
    ;;
  remove)
    valid_agent "$agent"
    found=0
    while read -r wt; do
      [[ "$wt" == "$WORKTREE_ROOT/$name/$agent-"* ]] || continue
      git -C "$repo" worktree remove --force "$wt" && echo "removed $wt" && found=1
    done < <(git -C "$repo" worktree list --porcelain | sed -n 's/^worktree //p')
    [[ $found -eq 1 ]] || echo "no worktrees for agent '$agent'" >&2
    ;;
  *) die "unknown command: $cmd" ;;
esac
