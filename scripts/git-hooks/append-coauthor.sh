#!/usr/bin/env sh
# append-coauthor - prepare-commit-msg helper: adds the Co-Authored-By trailer to a commit message, once.
# Author: Josh Neufield (Archon Tech)
#
#   append-coauthor.sh <commit-msg-file> [source]
#
# The trailer text is read from $COAUTHOR_TRAILER_FILE (default ~/.config/archon-agent-console/coauthor-trailer),
# so this script itself never contains an address. `git interpret-trailers --if-exists doNothing` skips the
# trailer when the identical line is already there, so re-running (amend, rebase, a hand-typed trailer) never
# duplicates it. Merge and squash messages are left alone. A missing trailer file is a no-op, never a failure.
msg_file="${1:-}"
source="${2:-}"
trailer_file="${COAUTHOR_TRAILER_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/archon-agent-console/coauthor-trailer}"

[ -n "$msg_file" ] && [ -f "$msg_file" ] || exit 0
[ -f "$trailer_file" ] || exit 0
# git may resolve a relative path from the repository root, so hand it an absolute one.
case "$msg_file" in /*) ;; *) msg_file="$PWD/$msg_file" ;; esac
case "$source" in merge|squash) exit 0 ;; esac

trailer="$(sed -n '1p' "$trailer_file" | tr -d '\r')"
case "$trailer" in *": "*) ;; *) exit 0 ;; esac

git interpret-trailers --in-place --if-exists doNothing --if-missing add --trailer "$trailer" "$msg_file"
