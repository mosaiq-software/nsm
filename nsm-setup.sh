#!/usr/bin/env bash
# Interactive NSM leader setup. Prompts for cluster, GitHub App, and OAuth settings, then writes
# /etc/nsm/nsm.env and /etc/nsm/github-app.pem, fixes ownership, rebuilds the management UI, and
# restarts nsmd. Safe to re-run: existing values are offered as defaults.
#
#   sudo nsm-setup
#
# Run this in a real terminal (not piped) so it can read your answers and the pasted private key.
set -euo pipefail

ETC_DIR="${NSM_ETC_DIR:-/etc/nsm}"
ENV_FILE="$ETC_DIR/nsm.env"
INSTALL_DIR="${NSM_INSTALL_DIR:-/opt/nsm}"
NSM_USER="${NSM_USER:-nsm}"
TTY="${NSM_SETUP_TTY:-/dev/tty}"

c_hd() { printf '\033[1;36m%s\033[0m\n' "$*"; }
c_ok() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }

[[ $EUID -ne 0 ]] && { echo "Must run as root (use: sudo nsm-setup)"; exit 1; }
if [[ ! -r "$TTY" ]]; then
    echo "nsm-setup needs an interactive terminal (it can't be piped). Run it directly: sudo nsm-setup" >&2
    exit 1
fi

# The env file is created by bootstrap; recover from the sample if a run got interrupted.
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$INSTALL_DIR/.env.sample" ]]; then
        mkdir -p "$ETC_DIR"
        cp "$INSTALL_DIR/.env.sample" "$ENV_FILE"
    else
        echo "No $ENV_FILE and no $INSTALL_DIR/.env.sample. Run the installer/bootstrap first." >&2
        exit 1
    fi
fi

# Current uncommented value of KEY (last wins, matching dotenv precedence).
get_env() {
    grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

# Upsert KEY=VALUE in place: replace the first active line, else append. Values are passed via the
# environment so awk treats them literally (no regex/escape surprises for secrets or URLs).
set_env() {
    local key="$1" val="$2" tmp
    tmp="$(mktemp)"
    K="$key" V="$val" awk '
        BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
        !done && $0 ~ "^" k "=" { print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
}

# ask VAR "prompt" "default" - reads one line from the terminal; empty input keeps the default.
ask() {
    local __var="$1" prompt="$2" default="${3:-}" input
    if [[ -n "$default" ]]; then
        printf '%s [%s]: ' "$prompt" "$default" > "$TTY"
    else
        printf '%s: ' "$prompt" > "$TTY"
    fi
    IFS= read -r input < "$TTY" || true
    [[ -z "$input" ]] && input="$default"
    printf -v "$__var" '%s' "$input"
}

# Like ask, but insists on an absolute path.
ask_dir() {
    local __var="$1" prompt="$2" default="${3:-}" val
    while :; do
        ask val "$prompt" "$default"
        [[ "$val" == /* ]] && { printf -v "$__var" '%s' "$val"; return; }
        c_warn "Please enter an absolute path (starting with /)."
    done
}

confirm() {
    local q="$1" def="${2:-Y}" ans hint="[Y/n]"
    [[ "$def" == "N" ]] && hint="[y/N]"
    printf '%s %s ' "$q" "$hint" > "$TTY"
    IFS= read -r ans < "$TTY" || true
    ans="${ans:-$def}"
    [[ "$ans" =~ ^[Yy] ]]
}

gen_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

default_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

c_hd "=== NSM leader setup ==="
echo "Configures $ENV_FILE and the GitHub App key, then restarts the daemon."
echo

role="$(get_env NSM_ROLE)"
if [[ "$role" != "leader" ]]; then
    c_warn "This node's NSM_ROLE is '${role:-unset}', not 'leader'. nsm-setup configures a leader."
    confirm "Continue anyway?" N || { echo "Aborted."; exit 0; }
fi

changed_ui=0

# --- Cluster secret -----------------------------------------------------------------------------
c_hd "1) Cluster secret"
echo "Every follower must use the EXACT same value. Write it down."
cur_secret="$(get_env CLUSTER_SECRET)"
if [[ -z "$cur_secret" || "$cur_secret" == "please-change-me" ]]; then
    if confirm "Generate a strong random cluster secret now?" Y; then
        cluster_secret="$(gen_secret)"
        c_ok "Generated: $cluster_secret"
    else
        ask cluster_secret "Enter the cluster secret"
    fi
else
    ask cluster_secret "Cluster secret (Enter to keep current)" "$cur_secret"
fi
set_env CLUSTER_SECRET "$cluster_secret"
echo

# --- Public URL ---------------------------------------------------------------------------------
c_hd "2) Public base URL of this leader"
echo "Where operators/followers reach the leader (used for the OAuth callback and join command)."
cur_public="$(get_env NSM_PUBLIC_URL)"
[[ -z "$cur_public" ]] && cur_public="$(get_env FRONTEND_URL)"
port="$(get_env API_PORT)"; port="${port:-1025}"
[[ -z "$cur_public" ]] && cur_public="http://$(default_ip):${port}"
ask public_url "Public base URL" "$cur_public"
public_url="${public_url%/}"
if [[ "$public_url" != "$(get_env FRONTEND_URL)" ]]; then changed_ui=1; fi
set_env NSM_PUBLIC_URL "$public_url"
set_env FRONTEND_URL "$public_url"
set_env API_URL "$public_url"
echo

# --- Storage directories ------------------------------------------------------------------------
c_hd "3) Storage directories"
echo "Where this machine keeps deployed app repos and persistent app data. Pick paths that exist on"
echo "this box (e.g. a mounted data drive); they are created recursively if missing."
cur_deploy="$(get_env DEPLOYMENT_PATH)"; cur_deploy="${cur_deploy:-/nsm/apps}"
cur_persist="$(get_env PERSISTENT_PATH)"; cur_persist="${cur_persist:-/var/lib/nsm/persistent}"
ask_dir deploy_path "Deployment path (app repos/containers)" "$cur_deploy"
ask_dir persist_path "Persistent data path (e.g. a mounted data drive)" "$cur_persist"
set_env DEPLOYMENT_PATH "$deploy_path"
set_env PERSISTENT_PATH "$persist_path"
echo

# --- GitHub App ---------------------------------------------------------------------------------
c_hd "4) GitHub App (repo access + teams)"
echo "Create it at GitHub -> Settings -> Developer settings -> GitHub Apps with Repository"
echo "'Contents: Read and write', 'Secrets: Read and write' and 'Workflows: Write' AND Organization"
echo "'Members: Read-only'. Contents/Secrets/Workflows let NSM provision managed CI/CD; Members lets"
echo "NSM discover teams and per-member permissions. Install it on the orgs/repos you deploy; each"
echo "installed org/user becomes an NSM team. Have the App ID and downloaded .pem ready."
ask app_id "GitHub App ID (number; blank = use SSH deploy key instead)" "$(get_env GITHUB_APP_ID)"
set_env GITHUB_APP_ID "$app_id"
ask app_inst "Installation ID (optional; blank = auto-resolve per repo)" "$(get_env GITHUB_APP_INSTALLATION_ID)"
set_env GITHUB_APP_INSTALLATION_ID "$app_inst"

if [[ -n "$app_id" ]]; then
    pem_path="$(get_env GITHUB_APP_PRIVATE_KEY_PATH)"; pem_path="${pem_path:-$ETC_DIR/github-app.pem}"
    set_env GITHUB_APP_PRIVATE_KEY_PATH "$pem_path"
    paste_key=1
    if [[ -f "$pem_path" ]] && grep -q "BEGIN" "$pem_path" 2>/dev/null; then
        confirm "A private key already exists at $pem_path. Keep it?" Y && paste_key=0
    fi
    if [[ "$paste_key" == 1 ]]; then
        while :; do
            echo "Paste the FULL contents of the App private key (.pem), including the"
            echo "-----BEGIN...-----  /  -----END...-----  lines. Then press Enter and Ctrl-D:"
            pem="$(cat "$TTY")"
            if [[ "$pem" == *"-----BEGIN"*"PRIVATE KEY-----"* && "$pem" == *"-----END"*"PRIVATE KEY-----"* ]]; then
                printf '%s\n' "$pem" > "$pem_path"
                c_ok "Saved private key to $pem_path"
                break
            fi
            c_warn "That doesn't look like a PEM private key."
            confirm "Try pasting again?" Y || { c_warn "Skipping key; App auth will not work until a key is provided."; break; }
        done
    fi
else
    c_warn "No App ID set - NSM will fall back to the shared SSH deploy key."
fi
echo

# --- GitHub OAuth (dashboard sign-in) -----------------------------------------------------------
c_hd "5) GitHub OAuth (dashboard sign-in)"
echo "From your GitHub OAuth App (Settings -> Developer settings -> OAuth Apps)."
ask oauth_client_id "OAuth client ID" "$(get_env VITE_GITHUB_OAUTH_CLIENT_ID)"
ask oauth_client_secret "OAuth client secret" "$(get_env GITHUB_OAUTH_CLIENT_SECRET)"
cur_cb="$(get_env VITE_GITHUB_OAUTH_CALLBACK_URL)"; cur_cb="${cur_cb:-$public_url/auth/github}"
ask oauth_callback "OAuth callback URL" "$cur_cb"
ask oauth_user "Super admin GitHub username (full access; manages the admin list)" "$(get_env VITE_GITHUB_OAUTH_DEFAULT_USER)"

for pair in \
    "VITE_GITHUB_OAUTH_CLIENT_ID=$oauth_client_id" \
    "VITE_GITHUB_OAUTH_CALLBACK_URL=$oauth_callback" \
    "VITE_GITHUB_OAUTH_DEFAULT_USER=$oauth_user"; do
    key="${pair%%=*}"; new="${pair#*=}"
    [[ "$(get_env "$key")" != "$new" ]] && changed_ui=1
    set_env "$key" "$new"
done
set_env GITHUB_OAUTH_CLIENT_SECRET "$oauth_client_secret"
set_env PRODUCTION true
echo

# --- Persist + secure ---------------------------------------------------------------------------
c_hd "6) Writing config"
chown "$NSM_USER":"$NSM_USER" "$ENV_FILE" 2>/dev/null || true
chmod 640 "$ENV_FILE" || true
if [[ -n "${pem_path:-}" && -f "${pem_path:-}" ]]; then
    chown "$NSM_USER":"$NSM_USER" "$pem_path" 2>/dev/null || true
    chmod 600 "$pem_path" || true
fi
# Create the storage directories (recursively) and hand them to the nsm user.
for d in "$deploy_path" "$persist_path"; do
    [[ -n "$d" ]] || continue
    mkdir -p "$d" && chown -R "$NSM_USER":"$NSM_USER" "$d" 2>/dev/null || c_warn "Could not create/own $d"
done
c_ok "Wrote $ENV_FILE"

# --- Rebuild UI (VITE_ values are baked in at build time) ----------------------------------------
if [[ "$changed_ui" == 1 ]]; then
    if confirm "OAuth/URL settings changed - rebuild the management UI now?" Y; then
        # shellcheck disable=SC1090
        source "$ENV_FILE"
        if [[ -d "$INSTALL_DIR" ]]; then
            c_hd "Building management UI..."
            (cd "$INSTALL_DIR" \
                && NSM_UI_OUT="${NSM_WWW_PATH:-/var/lib/nsm/www}" \
                   VITE_GITHUB_OAUTH_CLIENT_ID="${VITE_GITHUB_OAUTH_CLIENT_ID:-}" \
                   VITE_GITHUB_OAUTH_CALLBACK_URL="${VITE_GITHUB_OAUTH_CALLBACK_URL:-}" \
                   VITE_GITHUB_OAUTH_DEFAULT_USER="${VITE_GITHUB_OAUTH_DEFAULT_USER:-}" \
                   npm run build -w frontend)
            chown -R "$NSM_USER":"$NSM_USER" "${NSM_WWW_PATH:-/var/lib/nsm/www}" 2>/dev/null || true
            c_ok "UI rebuilt."
        else
            c_warn "$INSTALL_DIR missing; skipping UI build."
        fi
    fi
fi
echo

# --- Restart + verify ---------------------------------------------------------------------------
c_hd "7) Restarting nsmd"
if systemctl cat nsmd.service >/dev/null 2>&1; then
    systemctl restart nsmd && c_ok "nsmd restarted."
else
    c_warn "nsmd service not installed; skipping restart."
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
vport="${API_PORT:-1025}"
sleep 1
if health="$(curl -fsS "http://localhost:${vport}/healthz" 2>/dev/null)"; then
    if command -v jq >/dev/null 2>&1; then echo "$health" | jq . || echo "$health"; else echo "$health"; fi
    c_ok "Leader is healthy. Dashboard: ${NSM_PUBLIC_URL:-http://localhost:${vport}}"
else
    c_warn "Could not reach /healthz yet. Check logs: journalctl -u nsmd -f"
fi
