#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SCRIPT="${REPO_ROOT}/scripts/backup-volcano-workspaces.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invest-agent-backup-smoke.XXXXXX")"
SOURCE_ROOT="${TMP_ROOT}/source"
BACKUP_ROOT="${TMP_ROOT}/backup"

cleanup() {
  rm -rf -- "${TMP_ROOT}"
}
trap cleanup EXIT INT TERM

mkdir -p "${SOURCE_ROOT}/111/memory" "${SOURCE_ROOT}/dyk/config" "${SOURCE_ROOT}/mg" "${SOURCE_ROOT}/primary"
printf 'first\n' > "${SOURCE_ROOT}/111/memory/state.md"
printf 'config\n' > "${SOURCE_ROOT}/dyk/config/settings.yaml"
printf 'active\n' > "${SOURCE_ROOT}/mg/AGENTS.md"
printf 'excluded\n' > "${SOURCE_ROOT}/primary/AGENTS.md"
mkdir -p "${SOURCE_ROOT}/111/.codex/.tmp"
printf 'credential\n' > "${SOURCE_ROOT}/111/.codex/auth.json"
printf 'sandbox-secret\n' > "${SOURCE_ROOT}/111/.sandbox-token"
printf 'volatile\n' > "${SOURCE_ROOT}/111/.codex/logs_2.sqlite-wal"
printf 'temporary\n' > "${SOURCE_ROOT}/111/.codex/.tmp/item"
ln -s "memory/state.md" "${SOURCE_ROOT}/111/state-link"

run_backup() {
  VOLCANO_BACKUP_LOCAL_SOURCE="${SOURCE_ROOT}" \
  VOLCANO_BACKUP_ROOT="${BACKUP_ROOT}" \
  VOLCANO_BACKUP_LABEL="$1" \
  VOLCANO_BACKUP_VERIFY_ATTEMPTS=1 \
    "${BACKUP_SCRIPT}" >/dev/null
}

run_backup "2026-07-24T010000+0800"
run_backup "2026-07-25T010000+0800"
printf 'second\n' > "${SOURCE_ROOT}/111/memory/state.md"
run_backup "2026-07-26T010000+0800"
run_backup "2026-07-27T010000+0800"

[[ ! -e "${BACKUP_ROOT}/snapshots/2026-07-24T010000+0800" ]]
[[ -d "${BACKUP_ROOT}/snapshots/2026-07-25T010000+0800" ]]
[[ -d "${BACKUP_ROOT}/snapshots/2026-07-26T010000+0800" ]]
[[ -d "${BACKUP_ROOT}/snapshots/2026-07-27T010000+0800" ]]
[[ "$(readlink "${BACKUP_ROOT}/latest")" = "snapshots/2026-07-27T010000+0800" ]]
[[ -L "${BACKUP_ROOT}/latest/111/state-link" ]]
[[ -f "${BACKUP_ROOT}/latest/111/memory/state.md" ]]
[[ "$(cat "${BACKUP_ROOT}/latest/111/memory/state.md")" = "second" ]]
[[ ! -e "${BACKUP_ROOT}/latest/primary" ]]
[[ ! -e "${BACKUP_ROOT}/latest/111/.codex/auth.json" ]]
[[ ! -e "${BACKUP_ROOT}/latest/111/.sandbox-token" ]]
[[ ! -e "${BACKUP_ROOT}/latest/111/.codex/logs_2.sqlite-wal" ]]
[[ ! -e "${BACKUP_ROOT}/latest/111/.codex/.tmp" ]]
[[ -f "${BACKUP_ROOT}/manifests/2026-07-27T010000+0800.txt" ]]
grep -Eq '^content_manifest_sha256=[0-9a-f]{64}$' "${BACKUP_ROOT}/manifests/2026-07-27T010000+0800.txt"

foreign_root="${TMP_ROOT}/foreign"
mkdir -p "${foreign_root}"
printf 'do-not-touch\n' > "${foreign_root}/existing.txt"
if VOLCANO_BACKUP_LOCAL_SOURCE="${SOURCE_ROOT}" \
  VOLCANO_BACKUP_ROOT="${foreign_root}" \
  VOLCANO_BACKUP_LABEL="2026-07-27T020000+0800" \
  "${BACKUP_SCRIPT}" >/dev/null 2>&1; then
  printf 'expected uninitialized non-empty backup root to be rejected\n' >&2
  exit 1
fi
[[ "$(cat "${foreign_root}/existing.txt")" = "do-not-touch" ]]

printf 'volcano workspace backup smoke passed\n'
