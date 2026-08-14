#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-47.107.151.70}"
DEPLOY_USER="${DEPLOY_USER:-admin}"
REMOTE_DIR="${REMOTE_DIR:-/home/admin/invest-agent-portal}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
RUN_SMOKE="${RUN_SMOKE:-false}"
PORTAL_BASE="${PORTAL_BASE:-http://47.107.151.70:8088}"

echo "[portal-deploy] sync to ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}"
tar \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./data' \
  --exclude='./.env' \
  --exclude='./.env.local' \
  --exclude='./.env.production' \
  --exclude='./.git' \
  --exclude='./*.log' \
  -czf - . | ssh "${DEPLOY_USER}@${HOST}" "mkdir -p '${REMOTE_DIR}' && cd '${REMOTE_DIR}' && tar xzf -"

echo "[portal-deploy] remote build/restart"
ssh "${DEPLOY_USER}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' COMPOSE_FILE='${COMPOSE_FILE}' bash" <<'EOF'
set -euo pipefail
cd "${REMOTE_DIR}"

if [ ! -f .env.production ]; then
  echo "[portal-deploy] ERROR: ${REMOTE_DIR}/.env.production missing" >&2
  exit 1
fi

docker compose -f "${COMPOSE_FILE}" up -d --build
docker compose -f "${COMPOSE_FILE}" ps
EOF

echo "[portal-deploy] verify http"
curl -fsS "${PORTAL_BASE}/login" >/dev/null

if [ "${RUN_SMOKE}" = "true" ]; then
  echo "[portal-deploy] run smoke against ${PORTAL_BASE}"
  PORTAL_BASE="${PORTAL_BASE}" npx tsx scripts/smoke.ts
fi

echo "[portal-deploy] done: ${PORTAL_BASE}"
