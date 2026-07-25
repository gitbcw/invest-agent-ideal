#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-118.145.115.197}"
DEPLOY_USER="${DEPLOY_USER:-claude}"
REMOTE_DIR="${REMOTE_DIR:-~/invest-agent}"
PORT="${PORT:-22655}"
LOCAL_TUNNEL_PORT="${LOCAL_TUNNEL_PORT:-22648}"
RUN_SMOKE="${RUN_SMOKE:-false}"

echo "[deploy] sync to ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"
# Remove source files retired by the release after transfer while keeping all
# excluded runtime paths protected from deletion.
rsync -avz --delete-delay \
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
  --exclude='.hermes' \
  --exclude='.tmp' \
  --exclude='.state' \
  --exclude='workspaces' \
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
ssh "${DEPLOY_USER}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' RUN_SMOKE='${RUN_SMOKE}' bash" <<'EOF'
set -euo pipefail
cd "${REMOTE_DIR/#\~/$HOME}"

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
ssh "${DEPLOY_USER}@${HOST}" "PORT='${PORT}' bash" <<'EOF'
set -euo pipefail
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/health"; then
    exit 0
  fi
  sleep 2
done
pm2 logs invest-agent --err --lines 60 --nostream
exit 1
EOF
echo
echo "[deploy] done."
echo "[deploy] admin tunnel: ssh -L ${LOCAL_TUNNEL_PORT}:127.0.0.1:${PORT} ${DEPLOY_USER}@${HOST}"
echo "[deploy] admin ui after tunnel: http://127.0.0.1:${LOCAL_TUNNEL_PORT}/platform"
