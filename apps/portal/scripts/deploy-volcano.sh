#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-118.145.115.197}"
DEPLOY_USER="${DEPLOY_USER:-claude}"
REMOTE_DIR="${REMOTE_DIR:-/home/claude/invest-agent-mastra/apps/portal}"
PORTAL_BASE="${PORTAL_BASE:-http://127.0.0.1:23657}"

echo "[portal-volcano] sync to ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"
ssh "${DEPLOY_USER}@${HOST}" "mkdir -p '${REMOTE_DIR}'"
rsync -avz --delete-delay \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.next-dev' \
  --exclude='tsconfig.tsbuildinfo' \
  --exclude='data' \
  --exclude='logs' \
  --exclude='reviews' \
  --exclude='.state' \
  --exclude='workspaces' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.env.production' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  ./ "${DEPLOY_USER}@${HOST}:${REMOTE_DIR}/"

echo "[portal-volcano] remote install/build/restart"
ssh "${DEPLOY_USER}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' bash" <<'EOF'
set -euo pipefail
cd "${REMOTE_DIR}"

if [ ! -f .env ]; then
  echo "[portal-volcano] ERROR: ${REMOTE_DIR}/.env missing" >&2
  exit 1
fi

npm install
npm run build
mkdir -p logs data
if pm2 describe mastra-portal >/dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 list
EOF

echo "[portal-volcano] verify"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ssh "${DEPLOY_USER}@${HOST}" "curl -fsS '${PORTAL_BASE}/login' >/dev/null"; then
    portal_ready=true
    break
  fi
  sleep 2
done
if [ "${portal_ready:-false}" != "true" ]; then
  ssh "${DEPLOY_USER}@${HOST}" "pm2 logs mastra-portal --lines 60 --nostream"
  exit 1
fi
echo "[portal-volcano] done."
echo "[portal-volcano] portal health (on server): ${PORTAL_BASE}/login"
echo "[portal-volcano] public web: http://118.145.115.197:23657/login"
echo "[portal-volcano] if local web tunnel is needed, use a non-platform port, e.g. ssh -L 23659:127.0.0.1:23657 ${DEPLOY_USER}@${HOST}"
