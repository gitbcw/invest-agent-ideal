#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-118.145.115.197}"
DEPLOY_USER="${DEPLOY_USER:-claude}"
REMOTE_DIR="${REMOTE_DIR:-~/invest-agent}"
PORT="${PORT:-22655}"
LOCAL_TUNNEL_PORT="${LOCAL_TUNNEL_PORT:-22648}"
RUN_SMOKE="${RUN_SMOKE:-false}"

echo "[deploy] sync to ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"
rsync -avz \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='reviews' \
  --exclude='.env' \
  --exclude='.git' \
  --exclude='.backup' \
  --exclude='/.codex' \
  --exclude='.claude' \
  --exclude='.hermes' \
  --exclude='.tmp' \
  --exclude='.state' \
  --exclude='workspaces' \
  --exclude='*.log' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  ./ "${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"

echo "[deploy] remote install/build"
ssh "${DEPLOY_USER}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' RUN_SMOKE='${RUN_SMOKE}' bash" <<'EOF'
set -euo pipefail
cd "${REMOTE_DIR/#\~/$HOME}"

if [ ! -f .env ]; then
  echo "[deploy] WARN: .env missing"
fi

npm install
npm run build
if [ "${RUN_SMOKE:-false}" = "true" ]; then
  npm run smoke
fi

mkdir -p logs data reviews .state

if pm2 describe invest-agent >/dev/null 2>&1; then
  pm2 restart ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi

pm2 save
pm2 list
EOF

echo "[deploy] verify"
ssh "${DEPLOY_USER}@${HOST}" "curl -fsS http://127.0.0.1:${PORT}/health"
echo
echo "[deploy] done."
echo "[deploy] admin tunnel: ssh -L ${LOCAL_TUNNEL_PORT}:127.0.0.1:${PORT} ${DEPLOY_USER}@${HOST}"
echo "[deploy] admin ui after tunnel: http://127.0.0.1:${LOCAL_TUNNEL_PORT}/platform"
