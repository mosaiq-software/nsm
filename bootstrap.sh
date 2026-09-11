#!/usr/bin/env bash
# NSM node bootstrap: clone the repo, run this script, and the node installs itself and joins the
# cluster. Idempotent; safe to re-run.
#
#   The leader (exactly one; give this machine a DHCP reservation / static IP):
#     sudo ./bootstrap.sh --leader
#
#   A follower joining an existing cluster:
#     sudo ./bootstrap.sh --follower --leader http://<leader-ip>:<apiPort> --secret <CLUSTER_SECRET>
#
# Config is read from /etc/nsm/nsm.env (created from .env.sample on first run). Any values passed
# as environment variables override the file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR=/opt/nsm
ETC_DIR=/etc/nsm
ENV_FILE=$ETC_DIR/nsm.env

ROLE=""
LEADER_URL=""
SECRET="${CLUSTER_SECRET:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        # "--leader" alone selects the leader role; "--leader <url>" (with --follower) sets the
        # leader's address that this follower should point at.
        --leader)
            if [[ "${2:-}" == http* ]]; then LEADER_URL="$2"; shift 2; else ROLE="leader"; shift; fi ;;
        --follower) ROLE="follower"; shift ;;
        --leader-url) LEADER_URL="$2"; shift 2 ;;
        --secret) SECRET="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then echo "Must run as root"; exit 1; fi
if [[ -z "$ROLE" ]]; then echo "Specify --leader OR --follower --leader <url> --secret <secret>"; exit 1; fi

log() { echo -e "\033[1;36m[bootstrap]\033[0m $*"; }

# --- 1. System dependencies (no keepalived; agents run as containers) ---
install_deps() {
    log "Installing system dependencies..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y curl git nginx certbot python3-certbot-nginx netcat-openbsd jq rsync
    if ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y nodejs
    fi
    if ! command -v docker >/dev/null 2>&1; then
        curl -fsSL https://get.docker.com | sh
    fi
}

# --- 2. Lay down code + config ---
install_code() {
    log "Installing NSM code to $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR" "$ETC_DIR" /var/lib/nsm /etc/nsm/prometheus
    rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/" "$INSTALL_DIR/"
    (cd "$INSTALL_DIR" && npm ci)

    if [[ ! -f "$ENV_FILE" ]]; then
        log "Creating $ENV_FILE from sample (edit it to taste, then re-run)."
        cp "$INSTALL_DIR/.env.sample" "$ENV_FILE"
        local ip
        ip="$(hostname -I | awk '{print $1}')"
        sed -i "s/^NODE_ID=.*/NODE_ID=$(hostname)/" "$ENV_FILE"
        sed -i "s#^BIND_ADDRESS=.*#BIND_ADDRESS=${ip}#" "$ENV_FILE"
        sed -i "s/^NSM_ROLE=.*/NSM_ROLE=${ROLE}/" "$ENV_FILE"
        [[ -n "$LEADER_URL" ]] && sed -i "s#^LEADER_ADDRESS=.*#LEADER_ADDRESS=${LEADER_URL}#" "$ENV_FILE"
        [[ -n "$SECRET" ]] && sed -i "s/^CLUSTER_SECRET=.*/CLUSTER_SECRET=${SECRET}/" "$ENV_FILE"
        if [[ "$ROLE" == "leader" ]]; then
            sed -i "s#^LEADER_ADDRESS=.*#LEADER_ADDRESS=http://127.0.0.1:1025#" "$ENV_FILE"
        fi
    fi
}

# --- 2b. Build the management UI on the leader (served same-origin by the daemon) ---
build_frontend() {
    [[ "$ROLE" != "leader" ]] && return 0
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    log "Building management UI into ${NSM_WWW_PATH}..."
    mkdir -p "${NSM_WWW_PATH}"
    # Deps are already installed by the root `npm ci` (workspaces); build the frontend workspace.
    (cd "$INSTALL_DIR" \
        && NSM_UI_OUT="${NSM_WWW_PATH}" \
           VITE_GITHUB_OAUTH_CLIENT_ID="${VITE_GITHUB_OAUTH_CLIENT_ID:-}" \
           VITE_GITHUB_OAUTH_CALLBACK_URL="${VITE_GITHUB_OAUTH_CALLBACK_URL:-}" \
           VITE_GITHUB_OAUTH_DEFAULT_USER="${VITE_GITHUB_OAUTH_DEFAULT_USER:-}" \
           npm run build -w frontend)
}

# --- 3. systemd + nginx wiring (nginx ingress only needed on the leader) ---
install_services() {
    log "Installing systemd unit..."
    cp "$INSTALL_DIR/systemd/nsmd.service" /etc/systemd/system/nsmd.service
    systemctl daemon-reload
    if [[ "$ROLE" == "leader" ]]; then
        mkdir -p "$ETC_DIR/nginx"
        if ! grep -q "include /etc/nsm/nginx" /etc/nginx/nginx.conf; then
            sed -i "/http {/a \    include /etc/nsm/nginx/*.conf;" /etc/nginx/nginx.conf
        fi
        nginx -t && systemctl reload nginx || true
    fi
}

# --- 4. Observability: agents on every node; the stack on the leader ---
start_observability() {
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    log "Starting per-node observability agents..."
    NODE_ID="${NODE_ID:-$(hostname)}" OBS_LOKI_PUSH_URL="${OBS_LOKI_PUSH_URL:-}" \
        docker compose -p nsm-agent -f "$INSTALL_DIR/deploy/agent/docker-compose.yml" up -d || true
    if [[ "$ROLE" == "leader" ]]; then
        log "Starting observability stack (Grafana + Loki + Prometheus)..."
        docker compose -p nsm-observability -f "$INSTALL_DIR/deploy/observability/docker-compose.yml" up -d || true
    fi
}

# --- 5. Start nsmd (registers itself into the leader's registry at boot) ---
start_services() {
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    if [[ "$ROLE" == "follower" ]]; then
        [[ -z "${LEADER_ADDRESS:-}" ]] && { echo "LEADER_ADDRESS required for a follower"; exit 1; }
        [[ -z "${CLUSTER_SECRET:-}" ]] && { echo "CLUSTER_SECRET required for a follower"; exit 1; }
        # Early sanity check; nsmd also registers itself on boot.
        local ip
        ip="$(hostname -I | awk '{print $1}')"
        curl -fsS -X POST "${LEADER_ADDRESS}/cluster/register" \
            -H 'content-type: application/json' -H "x-nsm-cluster-secret: ${CLUSTER_SECRET}" \
            -d "{\"nodeId\":\"${NODE_ID}\",\"address\":\"${ip}\",\"apiPort\":${API_PORT:-1025}}" >/dev/null \
            || log "Warning: could not reach leader yet; nsmd will retry on boot."
    fi
    log "Enabling and starting nsmd..."
    systemctl enable --now nsmd
    log "Done. Check status: journalctl -u nsmd -f"
}

install_deps
install_code
build_frontend
install_services
start_observability
start_services
