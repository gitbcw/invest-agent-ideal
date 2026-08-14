#!/usr/bin/env bash
set -euo pipefail

# Starts the imported Portal and Mastra runtime as separate, isolated local
# processes. It deliberately has no production defaults.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTAL_DIR="$ROOT_DIR/apps/portal"
STATE_ROOT="${MAS_TRA_PORTAL_ROOT:-$ROOT_DIR/data/mastra-portal-local}"
RUNTIME_PORT="${MAS_TRA_PORT:-23656}"
PORTAL_PORT="${MAS_TRA_PORTAL_PORT:-23657}"
RELAY_PORT="${MAS_TRA_RELAY_PORT:-23658}"

mkdir -p "$STATE_ROOT"

# The local Portal seed account has one explicit, service-owned Mastra project.
# Bootstrap it before connector registration, rather than allowing a file route
# to infer a directory from Portal input.
(
  cd "$ROOT_DIR"
  DB_PATH="$STATE_ROOT/runtime/invest-agent.db" \
    MASTRA_PROJECTS_ROOT="$STATE_ROOT/runtime/projects" \
    WORKSPACE_BACKEND=mastra \
    node --import tsx -e 'import("./src/platform/project-registry.ts").then((module) => (module.ensureDefaultProjectForUser || module.default?.ensureDefaultProjectForUser)("primary"))'
)

cleanup() {
  trap - INT TERM EXIT
  [[ -n "${RUNTIME_PID:-}" ]] && kill "$RUNTIME_PID" 2>/dev/null || true
  [[ -n "${PORTAL_PID:-}" ]] && kill "$PORTAL_PID" 2>/dev/null || true
  wait "${RUNTIME_PID:-}" "${PORTAL_PID:-}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

(
  cd "$PORTAL_DIR"
  export NODE_ENV=development
  export PORTAL_PORT
  export PORTAL_RELAY_PORT="$RELAY_PORT"
  export PORTAL_DB_PATH="$STATE_ROOT/portal.db"
  export PORTAL_JWT_SECRET="mastra-local-portal-session-secret-20260813"
  export PORTAL_CONNECTOR_TOKEN="mastra-local-connector-token"
  export PORTAL_DISTRIBUTION_TOKEN="mastra-local-distribution-token"
  export PORTAL_COOKIE_SECURE=0
  export PORTAL_DEFAULT_ASSISTANT_ID="invest-agent-primary"
  export PORTAL_DEFAULT_INSTANCE_ID="invest-agent-primary"
  export PORTAL_DEFAULT_PROJECT_ID="invest-agent"
  exec npm run dev
) &
PORTAL_PID=$!

(
  cd "$ROOT_DIR"
  export MAS_TRA_PORT="$RUNTIME_PORT"
  export MAS_TRA_ROOT="$STATE_ROOT/runtime"
  export MASTRA_PROJECTS_ROOT="$STATE_ROOT/runtime/projects"
  export INVEST_AGENT_PORTAL_CONNECTOR_IN_OFFLINE_MODE=true
  export PORTAL_CONNECTOR_AUTO_START=true
  export PORTAL_RELAY_URL="ws://127.0.0.1:$RELAY_PORT"
  export PORTAL_CONNECTOR_TOKEN="mastra-local-connector-token"
  export PORTAL_LOCAL_ONLY=false
  exec bash scripts/run-mastra-local.sh
) &
RUNTIME_PID=$!

echo "Mastra runtime: http://127.0.0.1:$RUNTIME_PORT"
echo "Mastra Portal:  http://127.0.0.1:$PORTAL_PORT"
wait "$PORTAL_PID" "$RUNTIME_PID"
