#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-118.145.115.197}"
DEPLOY_USER="${DEPLOY_USER:-claude}"
REMOTE_DIR="${REMOTE_DIR:-/home/claude/invest-agent-mastra}"
PORT="${PORT:-23655}"
PORTAL_PORT="${PORTAL_PORT:-23657}"
PORTAL_BASE="${PORTAL_BASE:-http://127.0.0.1:${PORTAL_PORT}}"
LOCAL_TUNNEL_PORT="${LOCAL_TUNNEL_PORT:-23648}"
RUN_SMOKE="${RUN_SMOKE:-false}"
RELEASE_ID="${RELEASE_ID:-}"
RELEASE_COMMIT="${RELEASE_COMMIT:-}"
RELEASE_OPERATION="${RELEASE_OPERATION:-deploy}"
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10)

if [[ -n "${RELEASE_ID}" ]] && [[ ! "${RELEASE_ID}" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]]; then
  echo "[deploy] ERROR: invalid RELEASE_ID" >&2
  exit 2
fi
if [[ -n "${RELEASE_COMMIT}" ]] && [[ ! "${RELEASE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[deploy] ERROR: invalid RELEASE_COMMIT" >&2
  exit 2
fi
if [[ ! "${RELEASE_OPERATION}" =~ ^(deploy|rollback)$ ]]; then
  echo "[deploy] ERROR: invalid RELEASE_OPERATION" >&2
  exit 2
fi

echo "[deploy] sync to ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"
# Remove source files retired by the release after transfer while keeping all
# excluded runtime paths protected from deletion.
rsync -avz --delete-delay -e "ssh -o BatchMode=yes -o ConnectTimeout=10" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='reviews' \
  --exclude='eval-reports' \
  --exclude='tmp' \
  --exclude='.DS_Store' \
  --exclude='.gitignore.tmp' \
  --exclude='.env' \
  --exclude='.git' \
  --exclude='.backup' \
  --exclude='.deploy' \
  --exclude='/.codex' \
  --exclude='.claude' \
  --exclude='.zcode' \
  --exclude='.hermes' \
  --exclude='.tmp' \
  --exclude='.state' \
  --exclude='workspaces' \
  --exclude='apps/deploy-staging-portal-check' \
  --exclude='apps/portal/.next' \
  --exclude='ppt/images' \
  --exclude='scripts/launchd' \
  --exclude='src/prompts' \
  --exclude='tests/workflow-eval' \
  --exclude='tests/golden' \
  --exclude='tests/eval' \
  --exclude='tests/conversation-eval' \
  --exclude='*.log' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  ./ "${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"

echo "[deploy] remote install/build"
ssh "${SSH_OPTIONS[@]}" "${DEPLOY_USER}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' PORT='${PORT}' PORTAL_BASE='${PORTAL_BASE}' RUN_SMOKE='${RUN_SMOKE}' RELEASE_ID='${RELEASE_ID}' RELEASE_COMMIT='${RELEASE_COMMIT}' RELEASE_OPERATION='${RELEASE_OPERATION}' bash" <<'EOF'
set -euo pipefail
app_dir="${REMOTE_DIR/#\~/$HOME}"
portal_dir="${REMOTE_DIR/#\~/$HOME}/apps/portal"
portal_deploy_root="${REMOTE_DIR/#\~/$HOME}/.deploy"
portal_stamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
portal_previous="${portal_deploy_root}/portal-previous-${portal_stamp}"
portal_failed="${portal_deploy_root}/portal-failed-${portal_stamp}"
portal_process_existed=false
portal_process_started=false
portal_build_started=false

cd "${app_dir}"

if [ ! -f .env ]; then
  echo "[deploy] ERROR: .env missing"
  exit 1
fi

for required_name in INVEST_AGENT_API_TOKEN PLATFORM_ANONYMIZATION_SECRET; do
  if ! grep -Eq "^${required_name}=.{32,}$" .env; then
    echo "[deploy] ERROR: ${required_name} missing or too short"
    exit 1
  fi
done

npm install
npm run build
if [ "${RUN_SMOKE:-false}" = "true" ]; then
  npm test
fi

mkdir -p logs data .state "${portal_deploy_root}"

if [ ! -f "${portal_dir}/package.json" ] || [ ! -f "${portal_dir}/ecosystem.config.cjs" ]; then
  echo "[deploy] ERROR: Portal source directory is incomplete: ${portal_dir}" >&2
  exit 1
fi

# A Next build clears .next before compiling. Preserve the serving build and
# restore it automatically if compilation or acceptance fails.
restore_portal_on_failure() {
  local status=$?
  if [ "${status}" -ne 0 ] && [ "${portal_build_started}" = "true" ]; then
    echo "[deploy] Portal deployment failed; restoring the previous build" >&2
    if [ "${portal_process_started}" = "true" ]; then
      pm2 delete mastra-portal >/dev/null 2>&1 || true
    elif [ "${portal_process_existed}" = "true" ]; then
      pm2 stop mastra-portal >/dev/null 2>&1 || true
    fi
    if [ -e "${portal_dir}/.next" ] || [ -L "${portal_dir}/.next" ]; then
      mv -- "${portal_dir}/.next" "${portal_failed}" || true
    fi
    if [ -e "${portal_previous}" ] || [ -L "${portal_previous}" ]; then
      mv -- "${portal_previous}" "${portal_dir}/.next" || true
    fi
    if [ "${portal_process_existed}" = "true" ] && { [ -e "${portal_dir}/.next" ] || [ -L "${portal_dir}/.next" ]; }; then
      (cd "${portal_dir}" && pm2 restart ecosystem.config.cjs --update-env) >/dev/null 2>&1 || true
    fi
  fi
  trap - EXIT
  exit "${status}"
}
trap restore_portal_on_failure EXIT

(cd "${portal_dir}" && npm install --include=dev --no-audit --no-fund)

if pm2 describe mastra-portal >/dev/null 2>&1; then
  portal_process_existed=true
  pm2 stop mastra-portal
fi

if [ -e "${portal_dir}/.next" ] || [ -L "${portal_dir}/.next" ]; then
  mv -- "${portal_dir}/.next" "${portal_previous}"
fi
portal_build_started=true

(cd "${portal_dir}" && NODE_ENV=production npm run build)

for required_artifact in \
  "${portal_dir}/.next/BUILD_ID" \
  "${portal_dir}/.next/required-server-files.json" \
  "${portal_dir}/.next/routes-manifest.json" \
  "${portal_dir}/.next/server/pages/_error.js"; do
  if [ ! -s "${required_artifact}" ]; then
    echo "[deploy] ERROR: incomplete Portal build artifact: ${required_artifact}" >&2
    exit 1
  fi
done

if [ "${portal_process_existed}" = "true" ]; then
  (cd "${portal_dir}" && pm2 restart ecosystem.config.cjs --update-env)
else
  (cd "${portal_dir}" && pm2 start ecosystem.config.cjs)
  portal_process_started=true
fi

check_portal() {
  local login_html asset_path
  curl -fsS "${PORTAL_BASE}/api/health" >/dev/null || return 1
  login_html="$(curl -fsSL "${PORTAL_BASE}/login")" || return 1
  asset_path="$(printf '%s' "${login_html}" | grep -oE '/_next/static/[^"[:space:]]+\.(js|css)' | head -n 1 || true)"
  if [ -z "${asset_path}" ]; then
    echo "[deploy] Portal /login did not expose a /_next/static asset" >&2
    return 1
  fi
  curl -fsS "${PORTAL_BASE}${asset_path}" >/dev/null || return 1
}

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if check_portal; then
    break
  fi
  if [ "${attempt}" = "10" ]; then
    pm2 logs mastra-portal --err --lines 60 --nostream
    exit 1
  fi
  sleep 2
done

cd "${app_dir}"
if pm2 describe invest-agent-mastra >/dev/null 2>&1; then
  pm2 restart ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi

pm2 save
pm2 list

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null; then
    break
  fi
  if [ "${attempt}" = "10" ]; then
    pm2 logs invest-agent-mastra --err --lines 60 --nostream
    exit 1
  fi
  sleep 2
done

# Verify the rendered route and one hashed asset after the runtime reconnects.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if check_portal; then
    break
  fi
  if [ "${attempt}" = "10" ]; then
    pm2 logs mastra-portal --err --lines 60 --nostream
    exit 1
  fi
  sleep 2
done

if [ -n "${RELEASE_ID:-}" ]; then
  mkdir -p .deploy
  printf '{"releaseId":"%s","commit":"%s","operation":"%s","installedAt":"%s"}\n' \
    "${RELEASE_ID}" "${RELEASE_COMMIT}" "${RELEASE_OPERATION}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    > .deploy/release.json
  chmod 600 .deploy/release.json
fi

# Rollback copies are ~170MB each and accumulate with every deploy; keep the
# newest 3 (including this deploy's). portal-failed-* is failure forensics and
# stays until triaged manually.
( cd "${portal_deploy_root}" && ls -1d portal-previous-* 2>/dev/null | LC_ALL=C sort -r | tail -n +4 | xargs -r rm -rf -- ) || true

trap - EXIT
EOF
echo
echo "[deploy] done."
echo "[deploy] portal: http://118.145.115.197:${PORTAL_PORT}/chat"
echo "[deploy] admin ui: http://118.145.115.197:${PORT}/platform（密码验证直连）"
echo "[deploy] legacy tunnel alternative: ssh -L ${LOCAL_TUNNEL_PORT}:127.0.0.1:${PORT} ${DEPLOY_USER}@${HOST} -> http://127.0.0.1:${LOCAL_TUNNEL_PORT}/platform"
