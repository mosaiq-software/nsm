#!/usr/bin/env bash
# Completely remove NSM from this machine (services, containers, config, data, user) for a clean
# reinstall/test. Leaves system packages (node, docker, nginx, certbot) and Let's Encrypt certs in
# place unless you ask otherwise.
#
#   sudo ./uninstall.sh                 # interactive
#   sudo ./uninstall.sh --yes           # no prompt
#   sudo ./uninstall.sh --yes --purge-data     # also remove PERSISTENT_PATH
#   sudo ./uninstall.sh --yes --prune-docker   # also `docker system prune -af --volumes`
set -uo pipefail

ETC_DIR=/etc/nsm
ENV_FILE=$ETC_DIR/nsm.env
INSTALL_DIR=/opt/nsm
NSM_USER=nsm

ASSUME_YES=0
PURGE_DATA=0
PRUNE_DOCKER=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -y|--yes) ASSUME_YES=1; shift ;;
        --purge-data) PURGE_DATA=1; shift ;;
        --prune-docker) PRUNE_DOCKER=1; shift ;;
        -h|--help)
            sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

[[ $EUID -ne 0 ]] && { echo "Must run as root (use: sudo ./uninstall.sh)"; exit 1; }

log() { echo -e "\033[1;35m[uninstall]\033[0m $*"; }

# Load configured paths (best-effort) so we tear down the right locations.
DEPLOYMENT_PATH=/nsm/apps
PERSISTENT_PATH=""
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE" 2>/dev/null || true
fi
DEPLOY_PARENT="${DEPLOYMENT_PATH%/*}"

# Refuse to rm obviously dangerous paths.
safe_rm() {
    local p="$1"
    [[ -z "$p" || "$p" == "/" ]] && { log "refusing to remove '$p'"; return; }
    [[ "${#p}" -lt 2 ]] && { log "refusing to remove '$p'"; return; }
    rm -rf "$p"
}

if [[ "$ASSUME_YES" != 1 ]]; then
    echo "This will PERMANENTLY remove NSM from $(hostname):"
    echo "  - stop/disable nsmd and delete its systemd unit"
    echo "  - tear down NSM docker projects (agent, observability, and deployed apps)"
    echo "  - delete $INSTALL_DIR, $ETC_DIR, /var/lib/nsm, $DEPLOY_PARENT"
    echo "  - remove the '$NSM_USER' user, sudoers policy, and helper CLIs"
    [[ "$PURGE_DATA" == 1 ]] && echo "  - delete PERSISTENT_PATH ($PERSISTENT_PATH)"
    [[ "$PRUNE_DOCKER" == 1 ]] && echo "  - docker system prune -af --volumes"
    printf 'Type "wipe" to continue: '
    read -r ans
    [[ "$ans" == "wipe" ]] || { echo "Aborted."; exit 0; }
fi

# --- 1. Stop the daemon -------------------------------------------------------------------------
log "Stopping nsmd..."
systemctl stop nsmd 2>/dev/null || true
systemctl disable nsmd 2>/dev/null || true
pkill -u "$NSM_USER" 2>/dev/null || true

# --- 2. Tear down docker projects (while /opt/nsm compose files still exist) ---------------------
if command -v docker >/dev/null 2>&1; then
    log "Tearing down deployed app containers..."
    if [[ -d "$DEPLOYMENT_PATH" ]]; then
        for dir in "$DEPLOYMENT_PATH"/*/; do
            [[ -d "$dir" ]] || continue
            local_name="$(basename "$dir")"
            (cd "$dir" && docker compose -p "$local_name" down -v --remove-orphans) >/dev/null 2>&1 || true
        done
    fi
    log "Tearing down NSM observability + agent stacks..."
    agent_compose="$INSTALL_DIR/deploy/agent/docker-compose.yml"
    obs_compose="$INSTALL_DIR/deploy/observability/docker-compose.yml"
    [[ -f "$agent_compose" ]] && docker compose -p nsm-agent -f "$agent_compose" down -v >/dev/null 2>&1 || true
    [[ -f "$obs_compose" ]] && docker compose -p nsm-observability -f "$obs_compose" down -v >/dev/null 2>&1 || true
    # Fallback by project name in case the compose files are already gone.
    docker compose -p nsm-agent down -v >/dev/null 2>&1 || true
    docker compose -p nsm-observability down -v >/dev/null 2>&1 || true
fi

# --- 3. Remove systemd unit ---------------------------------------------------------------------
log "Removing systemd unit..."
rm -f /etc/systemd/system/nsmd.service
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed nsmd 2>/dev/null || true

# --- 4. Remove helper CLIs + sudoers policy -----------------------------------------------------
log "Removing helper CLIs and sudoers policy..."
rm -f /usr/local/sbin/nsm-setup /usr/local/sbin/nsm-apply-hosts /usr/local/sbin/nsm-uninstall
rm -f /etc/sudoers.d/nsm

# --- 5. Un-wire nginx ---------------------------------------------------------------------------
if [[ -f /etc/nginx/nginx.conf ]]; then
    log "Removing NSM nginx include..."
    sed -i '\#include /etc/nsm/nginx/\*.conf;#d' /etc/nginx/nginx.conf
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
fi

# --- 6. Restore /etc/hosts (strip the NSM-managed block) ----------------------------------------
if [[ -f /etc/hosts ]] && grep -q '# BEGIN NSM-managed' /etc/hosts; then
    log "Cleaning NSM block from /etc/hosts..."
    tmp="$(mktemp)"
    sed '/# BEGIN NSM-managed/,/# END NSM-managed/d' /etc/hosts > "$tmp"
    install -m 0644 -o root -g root "$tmp" /etc/hosts
    rm -f "$tmp"
fi

# --- 7. Remove files/dirs -----------------------------------------------------------------------
log "Deleting NSM directories..."
safe_rm "$INSTALL_DIR"
safe_rm "$ETC_DIR"
safe_rm /var/lib/nsm
safe_rm "$DEPLOYMENT_PATH"
[[ -n "$DEPLOY_PARENT" && "$DEPLOY_PARENT" != "$DEPLOYMENT_PATH" ]] && safe_rm "$DEPLOY_PARENT"
if [[ "$PURGE_DATA" == 1 && -n "$PERSISTENT_PATH" ]]; then
    log "Deleting PERSISTENT_PATH ($PERSISTENT_PATH)..."
    safe_rm "$PERSISTENT_PATH"
fi

# --- 8. Remove the nsm user ---------------------------------------------------------------------
if id -u "$NSM_USER" >/dev/null 2>&1; then
    log "Removing '$NSM_USER' user..."
    userdel "$NSM_USER" 2>/dev/null || true
fi

# --- 9. Optional deep docker prune --------------------------------------------------------------
if [[ "$PRUNE_DOCKER" == 1 ]] && command -v docker >/dev/null 2>&1; then
    log "Pruning docker (all unused images/containers/volumes)..."
    docker system prune -af --volumes >/dev/null 2>&1 || true
fi

log "Done. NSM removed."
echo "Left in place: system packages (node, docker, nginx, certbot) and Let's Encrypt certs."
echo "Reinstall the leader with:"
echo "  curl -fsSL https://raw.githubusercontent.com/mosaiq-software/nsm/main/install.sh | sudo bash -s -- --leader"
