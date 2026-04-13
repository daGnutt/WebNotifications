#!/usr/bin/env bash
# install.sh — Install Web Notifications as a systemd user service
set -euo pipefail

SERVICE_NAME="web-notifications"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME.service"

# ── Helpers ──────────────────────────────────────────────────────────────────
info()    { echo -e "\033[1;34m[info]\033[0m  $*"; }
success() { echo -e "\033[1;32m[ok]\033[0m    $*"; }
warn()    { echo -e "\033[1;33m[warn]\033[0m  $*"; }
die()     { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

# ── Preflight checks ─────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed or not in PATH"
command -v npm  >/dev/null 2>&1 || die "npm is not installed or not in PATH"
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — systemd required"

NODE_BIN="$(command -v node)"
info "Using node: $NODE_BIN ($(node --version))"
info "Project directory: $SCRIPT_DIR"

# ── secrets.json check ───────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/secrets.json" ]]; then
    warn "secrets.json not found. Copying secrets.example.json — edit it before starting the service."
    cp "$SCRIPT_DIR/secrets.example.json" "$SCRIPT_DIR/secrets.json"
fi

# ── npm install ───────────────────────────────────────────────────────────────
info "Installing npm dependencies..."
npm --prefix "$SCRIPT_DIR" install --omit=dev
success "Dependencies installed."

# ── Create systemd user service ───────────────────────────────────────────────
mkdir -p "$SYSTEMD_USER_DIR"

info "Writing $SERVICE_FILE"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Web Notifications Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# ── Enable + start ─────────────────────────────────────────────────────────
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

# ── Enable linger so service survives logout ──────────────────────────────
if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null && success "Linger enabled for $USER (service runs without an active login session)." \
        || warn "Could not enable linger — the service will stop when you log out. Run 'sudo loginctl enable-linger $USER' to fix this."
fi

# ── Status summary ────────────────────────────────────────────────────────
echo ""
systemctl --user status "$SERVICE_NAME" --no-pager -l || true
echo ""
success "Service '$SERVICE_NAME' installed and started."
echo ""
echo "  Useful commands:"
echo "    systemctl --user status  $SERVICE_NAME"
echo "    systemctl --user restart $SERVICE_NAME"
echo "    systemctl --user stop    $SERVICE_NAME"
echo "    journalctl --user -u     $SERVICE_NAME -f"
