#!/usr/bin/env bash
set -euo pipefail

# This migration runtime never shares main's port or state roots.
MAS_TRA_PORT="${MAS_TRA_PORT:-22656}"
MAS_TRA_ROOT="${MAS_TRA_ROOT:-$PWD/data/mastra-local}"
MAS_TRA_CODEX_CONFIG="${MAS_TRA_CODEX_CONFIG:-/Users/combo/.codex/config.toml}"
MAS_TRA_CODEX_AUTH="${MAS_TRA_CODEX_AUTH:-/Users/combo/.codex/auth.json}"

if [[ ! -f "$MAS_TRA_CODEX_CONFIG" || ! -f "$MAS_TRA_CODEX_AUTH" ]]; then
  echo "Codex gateway configuration is unavailable; set MAS_TRA_CODEX_CONFIG and MAS_TRA_CODEX_AUTH." >&2
  exit 2
fi

MAS_TRA_BASE_URL="$(node --input-type=module -e '
  import fs from "node:fs";
  const config = fs.readFileSync(process.argv[1], "utf8");
  const match = config.match(/^base_url\s*=\s*"([^"]+)"/m);
  if (!match) process.exit(2);
  process.stdout.write(match[1]);
' "$MAS_TRA_CODEX_CONFIG")"
MAS_TRA_KEY="$(node --input-type=module -e '
  import fs from "node:fs";
  const auth = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof auth.OPENAI_API_KEY !== "string" || !auth.OPENAI_API_KEY) process.exit(2);
  process.stdout.write(auth.OPENAI_API_KEY);
' "$MAS_TRA_CODEX_AUTH")"

mkdir -p "$MAS_TRA_ROOT"
export PORT="$MAS_TRA_PORT"
export HOST="127.0.0.1"
export NODE_ENV="development"
export INVEST_AGENT_OFFLINE_MODE="true"
export PORTAL_CONNECTOR_AUTO_START="false"
export WEIXIN_AUTO_START="false"
export PLATFORM_WEIXIN_AUTO_START="false"
export DB_PATH="$MAS_TRA_ROOT/invest-agent.db"
export WORKSPACE_ROOT="$MAS_TRA_ROOT/workspaces"
export RUNTIME_DATA_ROOT="$MAS_TRA_ROOT/runtime"
export REVIEWS_ROOT="$MAS_TRA_ROOT/reviews"
export INVEST_AGENT_API_TOKEN_FILE="$MAS_TRA_ROOT/.service-api-token"
export INVEST_AGENT_EXECUTION_BACKEND="mastra"
export MASTRA_GATEWAY_BASE_URL="$MAS_TRA_BASE_URL"
export MASTRA_GATEWAY_API_KEY="$MAS_TRA_KEY"
export MASTRA_GATEWAY_PROVIDER="openai"
export MASTRA_DEFAULT_MODEL="${MASTRA_DEFAULT_MODEL:-gpt-5.6-terra}"

echo "Mastra experiment runtime: http://127.0.0.1:$PORT"
echo "State root: $MAS_TRA_ROOT"
echo "Model: $MASTRA_DEFAULT_MODEL"
echo "Local API token path: $INVEST_AGENT_API_TOKEN_FILE"
exec node dist/index.js
