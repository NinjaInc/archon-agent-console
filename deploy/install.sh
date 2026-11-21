#!/usr/bin/env bash
# Install Archon Agent Console as a hardened systemd service under a dedicated user.
# Author: Josh Neufield (Archon Tech)
#
# Run as root from a built checkout (npm ci && npm run build):  sudo deploy/install.sh
# Idempotent. Review before running: it creates a system user, copies the app to /opt,
# and enables (but does not start the Cloudflare tunnel for) the service.
#
# IMPORTANT - what the `archon` user can see:
#   * It has its OWN home (/srv/archon). `claude login` and `agy` auth must be done AS archon:
#       sudo -u archon -H claude        sudo -u archon -H agy
#   * It can only read/write what you grant. Put projects under /srv/archon/projects, or give
#     the group access to existing repos (example at the end). Nothing in /home/<you> is exposed.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/archon-agent-console
ETC=/etc/archon-agent-console
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

[[ -f "$SRC/dist-server/server/index.js" ]] || { echo "build first: npm ci && npm run build" >&2; exit 1; }
[[ -x "$NODE_BIN" ]] || { echo "node not found; set NODE_BIN=/path/to/node" >&2; exit 1; }
case "$NODE_BIN" in /home/*|/root/*)
  echo "node at $NODE_BIN is inside a home directory the service cannot read." >&2
  echo "Install a system node (or copy it to /usr/local/bin) and re-run with NODE_BIN=..." >&2; exit 1;;
esac

id archon >/dev/null 2>&1 || useradd --system --create-home --home-dir /srv/archon --shell /usr/sbin/nologin archon
install -d -o archon -g archon -m 0750 /srv/archon/projects /var/lib/archon-agent-console /var/log/archon-agent-console
install -d -o root -g archon -m 0750 "$ETC"

# App files are owned by root and read-only to the service: a compromised agent cannot rewrite the app.
rm -rf "$APP"; install -d -m 0755 "$APP"
cp -a "$SRC/dist" "$SRC/dist-server" "$SRC/node_modules" "$SRC/package.json" "$SRC/public" "$SRC/shared" "$APP/"
chown -R root:root "$APP"

if [[ ! -f "$ETC/env" ]]; then
  install -m 0640 -o root -g archon "$SRC/.env.example" "$ETC/env"
  echo ">> Edit $ETC/env: APP_ORIGIN, RP_ID, CF_ACCESS_* (see README). Passkeys will not work until APP_ORIGIN is https."
fi

sed "s#^ExecStart=.*#ExecStart=$NODE_BIN dist-server/server/index.js#" "$SRC/deploy/systemd/archon-agent-console.service" > /etc/systemd/system/archon-agent-console.service
install -m 0644 "$SRC/deploy/logrotate/archon-agent-console" /etc/logrotate.d/archon-agent-console
systemctl daemon-reload
systemctl enable --now archon-agent-console.service
echo "Service started. First-run token (also in /var/log/archon-agent-console/server.log):"
sleep 3; grep -A3 "FIRST-RUN SETUP" /var/log/archon-agent-console/server.log | tail -6 || true

cat <<'NOTE'

To let the service edit an existing repo (example, run yourself):
  sudo setfacl -R -m u:archon:rwX /home/<you>/projects/<repo>
  sudo setfacl -R -d -m u:archon:rwX /home/<you>/projects/<repo>
  # and add that parent to PROJECTS_ROOTS in /etc/archon-agent-console/env
NOTE
