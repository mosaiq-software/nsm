#!/usr/bin/env bash
# One-command NSM installer. Fetches the NSM code, then delegates to bootstrap.sh.
#
#   Leader (first node), from GitHub:
#     curl -fsSL https://raw.githubusercontent.com/mosaiq-software/nsm/main/install.sh | sudo bash -s -- --leader
#
#   Follower (joining an existing cluster), served by the leader; --secret is the cluster join token:
#     curl -fsSL http://<leader-ip>:1025/install.sh | sudo bash -s -- --secret <CLUSTER_SECRET>
#
# The follower path downloads the code bundle and the shared git deploy key from the leader (both
# gated by the cluster secret), so a joining node needs nothing but this one command.
set -euo pipefail

# The leader templates this line when it serves /install.sh, baking in its own reachable URL.
NSM_LEADER_DEFAULT="${NSM_LEADER_DEFAULT:-}"
NSM_REPO="${NSM_REPO:-https://github.com/mosaiq-software/nsm.git}"
NSM_REF="${NSM_REF:-main}"

ROLE=""
LEADER_URL="$NSM_LEADER_DEFAULT"
SECRET="${CLUSTER_SECRET:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --leader) ROLE="leader"; shift ;;
        --follower) ROLE="follower"; shift ;;
        --leader-url) LEADER_URL="$2"; shift 2 ;;
        --secret) SECRET="$2"; shift 2 ;;
        --repo) NSM_REPO="$2"; shift 2 ;;
        --ref) NSM_REF="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# A --secret with no explicit role means "join as a follower".
[[ -z "$ROLE" && -n "$SECRET" ]] && ROLE="follower"
if [[ -z "$ROLE" ]]; then echo "Specify --leader OR --secret <token> [--leader-url <url>]"; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo "Must run as root (use sudo)"; exit 1; fi

log() { echo -e "\033[1;36m[install]\033[0m $*"; }

CLUSTER_SECRET_HEADER="x-nsm-cluster-secret"
SRC_DIR="$(mktemp -d /tmp/nsm-src.XXXXXX)"
trap 'rm -rf "$SRC_DIR"' EXIT

ensure_pkg() {
    if ! command -v "$1" >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -y
        apt-get install -y "${2:-$1}"
    fi
}

fetch_leader_code() {
    ensure_pkg git
    log "Cloning ${NSM_REPO}@${NSM_REF}..."
    git clone --depth 1 --branch "$NSM_REF" "$NSM_REPO" "$SRC_DIR"
}

fetch_follower_code() {
    ensure_pkg curl ca-certificates
    ensure_pkg tar
    [[ -z "$LEADER_URL" ]] && { echo "Follower needs the leader URL (--leader-url), or fetch install.sh from the leader"; exit 1; }
    [[ -z "$SECRET" ]] && { echo "Follower needs --secret <CLUSTER_SECRET>"; exit 1; }
    local base="${LEADER_URL%/}"

    log "Downloading NSM code bundle from ${base}..."
    curl -fsSL -H "${CLUSTER_SECRET_HEADER}: ${SECRET}" "${base}/install/bundle.tgz" | tar xz -C "$SRC_DIR"

    # Fetch the shared git deploy key so this node can clone app repos for deployments.
    local keydir="${GIT_SSH_KEY_DIR:-/etc/nsm/.ssh}"
    local keyfile="${GIT_SSH_KEY_FILE:-id_ed25519}"
    mkdir -p "$keydir"; chmod 700 "$keydir"
    log "Fetching shared deploy key..."
    curl -fsSL -H "${CLUSTER_SECRET_HEADER}: ${SECRET}" "${base}/cluster/deploy-key" -o "${keydir}/${keyfile}"
    chmod 600 "${keydir}/${keyfile}"
}

if [[ "$ROLE" == "leader" ]]; then
    fetch_leader_code
    bash "$SRC_DIR/bootstrap.sh" --leader
else
    fetch_follower_code
    bash "$SRC_DIR/bootstrap.sh" --follower --leader "$LEADER_URL" --secret "$SECRET"
fi
