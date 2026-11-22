#!/usr/bin/env bash
# install-craft-mcp - install ArtCraft "Crafting Apps" (PhotoCraft, WordCraft, ...) and register their
# built-in MCP servers, so Claude can edit PSD/DOCX/XLSX/PDF/SVG/... on this server.
# Author: Josh Neufield (Archon Tech)
#
#   scripts/install-craft-mcp.sh                 install the default set
#   scripts/install-craft-mcp.sh photo word pdf  install just these
#   scripts/install-craft-mcp.sh --list          show what is installed and where it is switched on
#   scripts/install-craft-mcp.sh --remove photo  switch off everywhere and delete an app
#
# Installing does NOT register anything with Claude. Each registered server adds its tools to every chat's prompt
# (all thirteen apps are about 860 tools), so switch them on only where needed: scripts/craft-mcp.sh on photo
#
# Each app is the vendor's own signed release from github.com/storytold/<app>craft (no third-party
# gateway). For every app this script checks, in order, before anything runs:
#   1. the signing key's fingerprint equals the one pinned below (key fetched from getartcraft.com),
#   2. the tarball's SHA-256 is in SHA256SUMS.txt,
#   3. SHA256SUMS.txt and the tarball both carry a good signature from that key,
#   4. the archive has no absolute or ".." paths,
#   5. the CLI starts and answers an MCP handshake with at least one tool.
# Switching an app on for a project is a separate, cheap step (scripts/craft-mcp.sh on <app>).
#
# Needs: gh (logged in), gpg, curl, tar, node (claude only for --remove). Installs under $CRAFT_ROOT
# (default ~/.local/opt/artcraft); nothing system-wide, no root.
set -euo pipefail

PINNED_FPR="2B76741B414AAD6CD33E631213A005C0B9D7C3ED"
KEY_URL="https://getartcraft.com/keys/artcraft.gpg"
DEFAULT_APPS=(photo word deck grid vector pdf light film design effect cad sound fig)
ROOT="${CRAFT_ROOT:-$HOME/.local/opt/artcraft}"
DL="${XDG_CACHE_HOME:-$HOME/.cache}/artcraft-dl"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "install-craft-mcp: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
for c in gh gpg curl tar node; do need "$c"; done

case "${1:-}" in
  --list)
    for d in "$ROOT"/*craft; do
      [ -e "$d" ] || continue
      echo "$(basename "$d") -> $(readlink "$d")"
    done
    "$HERE/craft-mcp.sh" status
    exit 0 ;;
  --remove)
    shift
    need claude
    for app in "$@"; do
      [[ "$app" =~ ^[a-z]{2,12}$ ]] || die "bad app name: $app"
      "$HERE/craft-mcp.sh" off "$app" --everywhere >/dev/null 2>&1 || true
      rm -rf "$ROOT/${app}craft" "$ROOT/${app}craft"-[0-9]*
      echo "removed ${app}craft"
    done
    exit 0 ;;
esac

APPS=("$@"); [ ${#APPS[@]} -gt 0 ] || APPS=("${DEFAULT_APPS[@]}")
for app in "${APPS[@]}"; do [[ "$app" =~ ^[a-z]{2,12}$ ]] || die "bad app name: $app"; done

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME; chmod 700 "$GNUPGHOME"
trap 'rm -rf "$GNUPGHOME"' EXIT
mkdir -p "$ROOT" "$DL"

curl -fsSL -m 30 "$KEY_URL" -o "$GNUPGHOME/artcraft.gpg"
gpg --quiet --import "$GNUPGHOME/artcraft.gpg" 2>/dev/null
FPR="$(gpg --with-colons --fingerprint 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')"
[ "$FPR" = "$PINNED_FPR" ] || die "the signing key from $KEY_URL has fingerprint $FPR, expected $PINNED_FPR - refusing to continue"
echo "signing key verified ($PINNED_FPR)"

ok=(); failed=()
install_app() {
  local app="$1" repo="storytold/${1}craft" tag ver tarball work top cli info
  tag="$(gh release view -R "$repo" --json tagName -q .tagName)" || return 1
  ver="${tag#v}"; tarball="${app}craft-${ver}-linux-x86_64.tar.gz"
  work="$DL/${app}craft-${ver}"; rm -rf "$work"; mkdir -p "$work"
  ( cd "$work" && gh release download "$tag" -R "$repo" -p "$tarball" -p "$tarball.asc" -p SHA256SUMS.txt -p SHA256SUMS.txt.asc ) || return 1
  ( cd "$work" && grep " $tarball\$" SHA256SUMS.txt | sha256sum -c - >/dev/null ) || { echo "  checksum mismatch"; return 1; }
  gpg --verify "$work/SHA256SUMS.txt.asc" "$work/SHA256SUMS.txt" 2>&1 | grep -q "Good signature" || { echo "  bad signature on SHA256SUMS.txt"; return 1; }
  gpg --verify "$work/$tarball.asc" "$work/$tarball" 2>&1 | grep -q "Good signature" || { echo "  bad signature on the tarball"; return 1; }
  if tar -tzf "$work/$tarball" | grep -q -E '^/|(^|/)\.\./'; then echo "  archive has unsafe paths"; return 1; fi
  rm -rf "$ROOT/${app}craft-${ver}"; mkdir -p "$ROOT/${app}craft-${ver}"
  tar -xzf "$work/$tarball" -C "$ROOT/${app}craft-${ver}" --no-same-owner
  top="$(find "$ROOT/${app}craft-${ver}" -mindepth 1 -maxdepth 1 -type d | head -1)"
  cli="$top/bin/${app}craft-cli"
  [ -x "$cli" ] || cli="$(find "$top/bin" -maxdepth 1 -name '*-cli' -type f | head -1)"
  [ -n "$cli" ] && [ -x "$cli" ] || { echo "  no CLI found in the release"; return 1; }
  ln -sfn "$top" "$ROOT/${app}craft"
  cli="$ROOT/${app}craft/bin/$(basename "$cli")"
  info="$(node "$HERE/mcp-probe.mjs" "$cli" mcp)" || return 1
  echo "  $info"
  rm -rf "$work"
}

for app in "${APPS[@]}"; do
  echo "== ${app}craft"
  if install_app "$app"; then ok+=("$app"); else failed+=("$app"); fi
done
echo
echo "installed: ${ok[*]:-none}"
echo "Nothing is switched on yet. To use one in a project:  scripts/craft-mcp.sh on photo --project /path/to/project"
[ ${#failed[@]} -eq 0 ] || { echo "FAILED: ${failed[*]}"; exit 1; }
