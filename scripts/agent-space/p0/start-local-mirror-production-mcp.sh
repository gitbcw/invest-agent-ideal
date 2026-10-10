#!/usr/bin/env bash
set -euo pipefail

# Temporary, read-only production MCP bridge for the local mirror.
# Credentials must be supplied by the caller and are never persisted.
: "${MIRROR_MCP_SSH_HOST:?set MIRROR_MCP_SSH_HOST, e.g. claude@118.145.115.197}"
: "${MIRROR_MARKET_DATA_TOKEN:?set MIRROR_MARKET_DATA_TOKEN for market-data-tool}"
: "${MIRROR_QSSE_TOKEN:?set MIRROR_QSSE_TOKEN for qsse-qlib}"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MARKET_PORT="${MIRROR_MARKET_PORT:-32640}"
QSSE_PORT="${MIRROR_QSSE_PORT:-32648}"
TUNNEL_PID=""

cleanup() {
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ssh -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L "${MARKET_PORT}:127.0.0.1:22640" \
  -L "${QSSE_PORT}:127.0.0.1:22648" \
  -N "$MIRROR_MCP_SSH_HOST" &
TUNNEL_PID=$!

for _ in {1..20}; do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "MCP SSH tunnel failed to start" >&2
    exit 1
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:${MARKET_PORT}/mcp" 2>/dev/null ||
     [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${MARKET_PORT}/mcp" 2>/dev/null)" == "401" ]]; then
    break
  fi
  sleep 0.2
done

if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
  echo "MCP SSH tunnel exited before the mirror started" >&2
  exit 1
fi

cd "$ROOT"
export INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true
export MARKET_DATA_MCP_URL="http://127.0.0.1:${MARKET_PORT}/mcp"
export MARKET_DATA_MCP_TOKEN="$MIRROR_MARKET_DATA_TOKEN"
export INVEST_AGENT_MCP_QSSE_ENABLED=true
export QSSE_MCP_URL="http://127.0.0.1:${QSSE_PORT}/mcp"
export QSSE_MCP_TOKEN="$MIRROR_QSSE_TOKEN"

node scripts/agent-space/p0/start-local-mirror.mjs
