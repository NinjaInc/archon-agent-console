#!/usr/bin/env bash
# install-searxng - install SearXNG as a private, loopback-only systemd USER service for the console's Web search.
# Author: Josh Neufield (Archon Tech)
#
#   scripts/install-searxng.sh                install (or re-run to repair) and start it
#   scripts/install-searxng.sh --ref <sha>    install a different SearXNG commit (a full 40-character SHA)
#   scripts/install-searxng.sh --status       is it running, and does a test search work
#   scripts/install-searxng.sh --uninstall    stop it and remove the service, the code and the venv (keeps your settings)
#
# No Docker, no root. It fetches ONE exact commit of github.com/searxng/searxng (pinned below, checked after the
# fetch), installs its pinned Python requirements into a private venv with uv, writes a settings file and a random
# secret into ~/.config/archon-agent-console/searxng (owner-only), and installs deploy/systemd/archon-searxng.service.
# It listens on 127.0.0.1:8888 only and is limited to 450 MB of memory so it can never take the console down.
set -euo pipefail

PINNED_REF="a7163d091037cae586c444b05f22ecca162bb492"   # 2026-11-23; bump deliberately and re-test
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OPT="$HOME/.local/opt/searxng"
CONF="$HOME/.config/archon-agent-console/searxng"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
URL="http://127.0.0.1:8888"

die() { echo "install-searxng: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

status() {
  systemctl --user is-active archon-searxng >/dev/null 2>&1 && echo "service: running" || echo "service: not running"
  if curl -fsS -m 5 "$URL/healthz" >/dev/null 2>&1; then
    echo "health:  ok"
    n="$(curl -fsS -m 20 "$URL/search?q=wikipedia&format=json" 2>/dev/null | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("results",[])))' 2>/dev/null || echo 0)"
    echo "search:  $n results for a test query"
  else
    echo "health:  not answering on $URL"
  fi
}

ref="$PINNED_REF"; mode=install
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) shift; [ $# -ge 1 ] || die "--ref needs a commit SHA"; ref="$1" ;;
    --status) mode=status ;;
    --uninstall) mode=uninstall ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || die "the ref must be a full 40-character commit SHA, not a branch or tag"

if [ "$mode" = status ]; then status; exit 0; fi

if [ "$mode" = uninstall ]; then
  systemctl --user disable --now archon-searxng >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/archon-searxng.service"; systemctl --user daemon-reload
  rm -rf "$OPT"
  echo "removed the service, code and venv. Your settings in $CONF were kept."
  exit 0
fi

for c in git uv curl python3 systemctl; do need "$c"; done
[ -f "$REPO/deploy/systemd/archon-searxng.service" ] && [ -f "$REPO/deploy/searxng/settings.yml" ] || die "run this from a checkout of the console repository"

mkdir -p "$OPT" "$CONF" "$UNIT_DIR"; chmod 700 "$CONF"

# 1. The code: exactly one commit, verified after the fetch.
if [ ! -d "$OPT/src/.git" ]; then git init -q "$OPT/src"; git -C "$OPT/src" remote add origin https://github.com/searxng/searxng.git; fi
git -C "$OPT/src" fetch -q --depth 1 origin "$ref"
git -C "$OPT/src" checkout -q --force FETCH_HEAD
[ "$(git -C "$OPT/src" rev-parse HEAD)" = "$ref" ] || die "fetched commit does not match $ref - refusing to continue"
echo "code: searxng $ref"

# 2. The private Python environment (the versions in SearXNG's own pinned requirement files).
[ -x "$OPT/venv/bin/python" ] || uv venv -q --python 3.12 "$OPT/venv"
uv pip install -q --python "$OPT/venv/bin/python" -r "$OPT/src/requirements.txt" -r "$OPT/src/requirements-server.txt"
echo "venv: ready"

# 3. Settings and a random secret, both owner-only. An existing settings file is never overwritten (it is yours to edit).
[ -f "$CONF/settings.yml" ] || install -m 600 "$REPO/deploy/searxng/settings.yml" "$CONF/settings.yml"
if [ ! -f "$CONF/env" ]; then
  umask 077
  printf 'SEARXNG_SECRET=%s\n' "$(python3 -c 'import secrets; print(secrets.token_hex(32))')" > "$CONF/env"
fi
chmod 600 "$CONF/settings.yml" "$CONF/env"
echo "settings: $CONF"

# 4. The service.
install -m 644 "$REPO/deploy/systemd/archon-searxng.service" "$UNIT_DIR/archon-searxng.service"
systemctl --user daemon-reload
systemctl --user enable --now archon-searxng >/dev/null 2>&1 || systemctl --user restart archon-searxng
for _ in $(seq 1 30); do curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1 && break; sleep 1; done
status
