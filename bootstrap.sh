#!/usr/bin/env bash
# NSM node bootstrap: clone the repo, run this script, and the node installs itself and
# joins the cluster. Idempotent; safe to re-run.
#
#   First node of a NEW cluster:
#     sudo ./bootstrap.sh --init
#
#   Additional node joining an EXISTING cluster:
#     sudo ./bootstrap.sh --join http://<leader-or-vip>:<apiPort> --secret <CLUSTER_SECRET>
#
# Config is read from /etc/nsm/nsm.env (created from .env.sample on first run). Any values
# passed as environment variables override the file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR=/opt/nsm
ETC_DIR=/etc/nsm
ENV_FILE=$ETC_DIR/nsm.env
CLUSTER_FILE=$ETC_DIR/cluster.json

MODE=""
JOIN_URL=""
SECRET="${CLUSTER_SECRET:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --init) MODE="init"; shift ;;
        --join) MODE="join"; JOIN_URL="$2"; shift 2 ;;
        --secret) SECRET="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then echo "Must run as root"; exit 1; fi
if [[ -z "$MODE" ]]; then echo "Specify --init or --join <url> --secret <secret>"; exit 1; fi

log() { echo -e "\033[1;36m[bootstrap]\033[0m $*"; }

# --- 1. System dependencies ---
install_deps() {
    log "Installing system dependencies..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y curl git nginx keepalived certbot python3-certbot-nginx netcat-openbsd jq
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
    mkdir -p "$INSTALL_DIR" "$ETC_DIR" /var/lib/nsm
    rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/" "$INSTALL_DIR/"
    (cd "$INSTALL_DIR" && npm ci)

    if [[ ! -f "$ENV_FILE" ]]; then
        log "Creating $ENV_FILE from sample (edit it to taste, then re-run)."
        cp "$INSTALL_DIR/.env.sample" "$ENV_FILE"
        # Best-effort auto-detection of identity/network values.
        local ip iface
        ip="$(hostname -I | awk '{print $1}')"
        iface="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $5; exit}')"
        sed -i "s/^NODE_ID=.*/NODE_ID=$(hostname)/" "$ENV_FILE"
        sed -i "s/^BIND_ADDRESS=.*/BIND_ADDRESS=${ip}/" "$ENV_FILE"
        sed -i "s/^VRRP_IFACE=.*/VRRP_IFACE=${iface}/" "$ENV_FILE"
        [[ -n "$SECRET" ]] && sed -i "s/^CLUSTER_SECRET=.*/CLUSTER_SECRET=${SECRET}/" "$ENV_FILE"
    fi
}

# --- 3. systemd + nginx wiring ---
install_services() {
    log "Installing systemd unit + nginx include..."
    cp "$INSTALL_DIR/systemd/nsmd.service" /etc/systemd/system/nsmd.service
    systemctl daemon-reload
    mkdir -p "$ETC_DIR/nginx"
    if ! grep -q "include /etc/nsm/nginx" /etc/nginx/nginx.conf; then
        sed -i "/http {/a \    include /etc/nsm/nginx/*.conf;" /etc/nginx/nginx.conf
    fi
    nginx -t && systemctl reload nginx || true
}

# --- 4. Cluster membership ---
self_node_json() {
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    cat <<EOF
{"nodeId":"${NODE_ID}","address":"${BIND_ADDRESS}","raftPort":${RAFT_PORT:-1027},"apiPort":${API_PORT:-1025}}
EOF
}

configure_membership() {
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    if [[ "$MODE" == "init" ]]; then
        log "Initializing a new single-node cluster."
        self_node_json > /tmp/self.json
        jq -n --argjson n "$(cat /tmp/self.json)" --arg vip "${VIP:-}" --argjson rid "${VRRP_ROUTER_ID:-51}" \
            '{clusterId:"nsm",nodes:[$n],vip:$vip,vrrpRouterId:$rid}' > "$CLUSTER_FILE"
        sed -i "s/^NSM_BOOTSTRAP=.*/NSM_BOOTSTRAP=init/" "$ENV_FILE"
    else
        log "Joining existing cluster at $JOIN_URL ..."
        [[ -z "$SECRET" ]] && { echo "--secret required for join"; exit 1; }
        local body resp
        body="$(jq -n --argjson node "$(self_node_json)" --arg token "$SECRET" '{node:$node,token:$token}')"
        resp="$(curl -fsS -X POST "$JOIN_URL/cluster/join" -H 'content-type: application/json' -H "x-nsm-cluster-secret: $SECRET" -d "$body")"
        echo "$resp" | jq -e '.ok == true' >/dev/null || { echo "Join failed: $resp"; exit 1; }
        echo "$resp" | jq '.cluster' > "$CLUSTER_FILE"
        sed -i "s/^NSM_BOOTSTRAP=.*/NSM_BOOTSTRAP=/" "$ENV_FILE"
    fi
    log "Wrote $CLUSTER_FILE"
}

start_services() {
    log "Enabling and starting services..."
    systemctl enable --now keepalived || true
    systemctl enable --now nsmd
    log "Done. Check status: journalctl -u nsmd -f"
}

install_deps
install_code
install_services
configure_membership
start_services
