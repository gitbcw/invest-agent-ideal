#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/ops/searxng/compose.yml"
secret_file="${SEARXNG_SECRET_FILE:-$repo_root/data/.searxng-secret}"
searxng_port="${SEARXNG_PORT:-8888}"

ensure_secret() {
  if [[ ! -s "$secret_file" ]]; then
    mkdir -p "$(dirname "$secret_file")"
    umask 077
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 > "$secret_file"
    else
      od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$secret_file"
    fi
  fi
  export SEARXNG_SECRET
  SEARXNG_SECRET="$(tr -d '\r\n' < "$secret_file")"
  export SEARXNG_PORT="$searxng_port"
}

compose() {
  docker compose --project-name invest-agent-search --file "$compose_file" "$@"
}

health() {
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${searxng_port}/healthz"
  printf '\n'
}

case "${1:-}" in
  up)
    ensure_secret
    compose up --detach --wait
    health
    ;;
  down)
    ensure_secret
    compose down
    ;;
  health)
    health
    ;;
  logs)
    ensure_secret
    compose logs --follow --tail=100
    ;;
  status)
    ensure_secret
    compose ps
    ;;
  *)
    echo "Usage: $0 {up|down|health|logs|status}" >&2
    exit 2
    ;;
esac
