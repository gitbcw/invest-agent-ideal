#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-118.145.115.197}"
DEPLOY_USER="${DEPLOY_USER:-claude}"
REMOTE_DIR="${REMOTE_DIR:-~/invest-agent}"
PORT="${PORT:-22648}"

echo "[deploy] sync to ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"
rsync -avz \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='reviews' \
  --exclude='.git' \
  --exclude='.state' \
  --exclude='*.log' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  ./ "${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"

echo "[deploy] remote install/build"
ssh "${DEPLOY_USER}@${HOST}" bash <<'EOF'
set -euo pipefail
cd ~/invest-agent

if [ ! -f .env ]; then
  echo "[deploy] WARN: .env missing"
fi

npm install
npm run build
npm run smoke

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
echo "[deploy] done. admin ui: http://${HOST}:${PORT}/admin/weixin"
