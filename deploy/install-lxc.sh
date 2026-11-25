#!/usr/bin/env bash
# Installs (or updates) Shelfmark as a systemd service on Debian or Ubuntu,
# for example inside a Proxmox LXC container. Run it as root from a copy of
# this repository:
#
#   ./deploy/install-lxc.sh
#
# Running it again later updates the app and keeps your settings and data.
#
# Optional, set before the first run:
#   DOWNLOAD_DIR=/downloads   where received files are saved (your bind mount)
#   RUN_UID=1000 RUN_GID=1000 give the service user these ids, to match the
#                             owner of the files on a bind-mounted folder
set -euo pipefail

APP_DIR=/opt/shelfmark
DATA_DIR=/var/lib/shelfmark
ENV_FILE=/etc/shelfmark.env
UNIT=/etc/systemd/system/shelfmark.service
RUN_USER=shelfmark
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/downloads}"

die() { echo "Error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "run this as root."
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/server/index.js" ] || die "run this from inside the Shelfmark repository."
command -v apt-get >/dev/null || die "this script is for Debian and Ubuntu."

# --- Node.js 24 or newer -----------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 24 ]; then
  say "Installing Node.js 24"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  if ! curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/tmp/shelfmark-node-setup.log 2>&1; then
    cat /tmp/shelfmark-node-setup.log >&2
    die "the Node.js package source could not be set up."
  fi
  apt-get install -y -qq nodejs >/dev/null
  [ "$(node_major)" -ge 24 ] || die "Node.js 24 could not be installed."
fi
say "Node.js $(node --version)"

# --- the user the app runs as ------------------------------------------------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  say "Creating the user $RUN_USER"
  # With ids chosen by you it is an ordinary account; otherwise a system one.
  if [ -n "${RUN_GID:-}" ]; then groupadd --gid "$RUN_GID" "$RUN_USER"; else groupadd --system "$RUN_USER"; fi
  if [ -n "${RUN_UID:-}" ]; then uid_option=(--uid "$RUN_UID"); else uid_option=(--system); fi
  useradd --gid "$RUN_USER" "${uid_option[@]}" \
    --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

# --- the app itself ----------------------------------------------------------
say "Copying the app to $APP_DIR"
install -d "$APP_DIR"
rm -rf "$APP_DIR/server" "$APP_DIR/public"
cp -r "$SRC/server" "$SRC/public" "$SRC/package.json" "$APP_DIR/"
chown -R root:root "$APP_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 750 "$DATA_DIR"

# --- settings: written once, never overwritten -------------------------------
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Shelfmark settings. After changing this file: systemctl restart shelfmark
PORT=3000
DATA_DIR=$DATA_DIR

# Where files received over IRC are saved.
DOWNLOAD_DIR=$DOWNLOAD_DIR

# Set a password to require sign-in for the whole app. Recommended: anyone who
# can open the app can also use its IRC connection.
APP_PASSWORD=
APP_USERNAME=

# Only for senders behind a firewall (reverse DCC). Forward these ports from
# your router to this machine, and fill in your public IP address if the app
# cannot work it out by itself.
#DCC_PORTS=50000-50010
#DCC_PUBLIC_IP=
EOF
  chown root:"$RUN_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
else
  say "Keeping the existing $ENV_FILE"
fi

# --- the service -------------------------------------------------------------
install -m 644 "$SRC/deploy/shelfmark.service" "$UNIT"
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --quiet shelfmark
  systemctl restart shelfmark
  sleep 2
  systemctl is-active --quiet shelfmark || die "the service did not start. Look at: journalctl -u shelfmark -n 50"
  say "Shelfmark is running"
else
  say "systemd is not running here, so the service was installed but not started."
fi

# --- can the app write to the download folder? -------------------------------
# shellcheck disable=SC1090
SAVED_DIR="$(. "$ENV_FILE" && echo "${DOWNLOAD_DIR:-}")"
if [ -n "$SAVED_DIR" ] && [ -d "$SAVED_DIR" ]; then
  if ! runuser -u "$RUN_USER" -- test -w "$SAVED_DIR"; then
    echo
    echo "Warning: the user $RUN_USER (uid $(id -u "$RUN_USER")) cannot write to $SAVED_DIR."
    echo "Downloads will fail until it can. See 'Folder permissions' in DEPLOYMENT.md."
  fi
elif [ -n "$SAVED_DIR" ]; then
  echo
  echo "Note: $SAVED_DIR does not exist yet. Mount your storage there (see DEPLOYMENT.md),"
  echo "or the app will try to create it on this container's own disk."
fi

ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Open http://${ADDRESS:-this-machine}:3000"
echo "Settings: $ENV_FILE    Logs: journalctl -u shelfmark -f"
