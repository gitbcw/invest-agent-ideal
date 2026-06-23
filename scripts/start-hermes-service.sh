#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-22649}"
export HERMES_EXPERIMENT_ENABLED="${HERMES_EXPERIMENT_ENABLED:-true}"
export HERMES_PROFILE="${HERMES_PROFILE:-invest-agent}"
export WEIXIN_AUTO_START="${WEIXIN_AUTO_START:-false}"
export HERMES_WEIXIN_AUTO_START="${HERMES_WEIXIN_AUTO_START:-true}"
export INVEST_AGENT_WEIXIN_STATE_DIR="${INVEST_AGENT_WEIXIN_STATE_DIR:-$ROOT_DIR/.state}"
export HERMES_ACP_CWD="${HERMES_ACP_CWD:-$ROOT_DIR}"

mkdir -p "$ROOT_DIR/logs" "$ROOT_DIR/data" "$INVEST_AGENT_WEIXIN_STATE_DIR"

if [ ! -d "$ROOT_DIR/dist" ]; then
  npm run build
fi

exec /Users/combo/.nvm/versions/node/v22.22.0/bin/node "$ROOT_DIR/dist/index.js"
