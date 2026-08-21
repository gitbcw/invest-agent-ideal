#!/usr/bin/env bash
set -euo pipefail

PACKAGE_PATH="${1:-}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/claude/invest-agent-mastra}"
REMOTE_DATA_ROOT="${REMOTE_DATA_ROOT:-/home/claude/invest-agent-mastra/data}"
WORKSPACE_DIR="${WORKSPACE_DIR:-${REMOTE_DATA_ROOT}/workspaces}"
BACKUP_DIR="${BACKUP_DIR:-${REMOTE_DATA_ROOT}/migration-backups}"

if [ "${CONFIRM_RUNTIME_APPLY:-}" != "replace-runtime-and-data" ]; then
  echo "[apply] refusing to replace runtime data without CONFIRM_RUNTIME_APPLY=replace-runtime-and-data" >&2
  exit 2
fi

if [ -z "${EXPECTED_REMOTE_APP_DIR:-}" ] || [ "${EXPECTED_REMOTE_APP_DIR}" != "${REMOTE_APP_DIR}" ]; then
  echo "[apply] EXPECTED_REMOTE_APP_DIR must exactly match REMOTE_APP_DIR=${REMOTE_APP_DIR}" >&2
  exit 2
fi

if [ -z "${PACKAGE_PATH}" ]; then
  echo "usage: scripts/apply-volcano-runtime.sh /path/to/invest-agent-runtime-YYYYmmdd-HHMMSS.tgz" >&2
  exit 2
fi

if [ ! -f "${PACKAGE_PATH}" ]; then
  echo "[apply] package not found: ${PACKAGE_PATH}" >&2
  exit 1
fi

if [ -z "${EXPECTED_PACKAGE_SHA256:-}" ]; then
  echo "[apply] EXPECTED_PACKAGE_SHA256 is required" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_PACKAGE_SHA256="$(sha256sum "${PACKAGE_PATH}" | awk '{print $1}')"
else
  ACTUAL_PACKAGE_SHA256="$(shasum -a 256 "${PACKAGE_PATH}" | awk '{print $1}')"
fi
if [ "${ACTUAL_PACKAGE_SHA256}" != "${EXPECTED_PACKAGE_SHA256}" ]; then
  echo "[apply] package SHA256 mismatch" >&2
  exit 2
fi

mkdir -p "${REMOTE_APP_DIR}/data" "${REMOTE_APP_DIR}/reviews" "${WORKSPACE_DIR}" "${BACKUP_DIR}"

sqlite_tables() {
  local db_path="$1"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${db_path}" '.tables'
    return
  fi
  (cd "${REMOTE_APP_DIR}" && node - "${db_path}" <<'NODE'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
for (const row of db.prepare("select name from sqlite_master where type = 'table' order by name").all()) {
  console.log(row.name);
}
db.close();
NODE
  )
}

sqlite_quick_check() {
  local db_path="$1"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${db_path}" 'PRAGMA quick_check;'
    return
  fi
  (cd "${REMOTE_APP_DIR}" && node - "${db_path}" <<'NODE'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
console.log(db.pragma("quick_check", { simple: true }));
db.close();
NODE
  )
}

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "[apply] backup current server runtime to ${BACKUP_DIR}/${STAMP}"
mkdir -p "${BACKUP_DIR}/${STAMP}"
for path in "${REMOTE_APP_DIR}/data/runtime.db" "${REMOTE_APP_DIR}/reviews" "${WORKSPACE_DIR}"; do
  if [ -e "${path}" ]; then
    cp -a "${path}" "${BACKUP_DIR}/${STAMP}/"
  fi
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "[apply] unpack ${PACKAGE_PATH}"
tar xzf "${PACKAGE_PATH}" -C "${TMP_DIR}"

if [ ! -f "${TMP_DIR}/runtime.db" ]; then
  echo "[apply] package missing runtime.db" >&2
  exit 1
fi

if [ "$(sqlite_quick_check "${TMP_DIR}/runtime.db")" != "ok" ]; then
  echo "[apply] package database failed PRAGMA quick_check" >&2
  exit 1
fi

if [ -f "${REMOTE_APP_DIR}/data/runtime.db" ]; then
  BACKUP_DB="${BACKUP_DIR}/${STAMP}/runtime.db"
  if [ ! -f "${BACKUP_DB}" ] || [ "$(sqlite_quick_check "${BACKUP_DB}")" != "ok" ]; then
    echo "[apply] database backup missing or invalid" >&2
    exit 1
  fi
fi

install -m 0644 "${TMP_DIR}/runtime.db" "${REMOTE_APP_DIR}/data/runtime.db"
for suffix in wal shm; do
  if [ -f "${TMP_DIR}/runtime.db-${suffix}" ]; then
    install -m 0644 "${TMP_DIR}/runtime.db-${suffix}" "${REMOTE_APP_DIR}/data/runtime.db-${suffix}"
  else
    rm -f "${REMOTE_APP_DIR}/data/runtime.db-${suffix}"
  fi
done

if [ -d "${TMP_DIR}/reviews" ]; then
  rm -rf "${REMOTE_APP_DIR}/reviews"
  cp -a "${TMP_DIR}/reviews" "${REMOTE_APP_DIR}/reviews"
fi

if [ -d "${TMP_DIR}/workspaces" ]; then
  rm -rf "${WORKSPACE_DIR}"
  mkdir -p "$(dirname "${WORKSPACE_DIR}")"
  cp -a "${TMP_DIR}/workspaces" "${WORKSPACE_DIR}"
fi

if [ -d "${WORKSPACE_DIR}" ]; then
  echo "[apply] normalize workspace Codex runtime links"
  find "${WORKSPACE_DIR}" -mindepth 2 -maxdepth 2 -type d -name .codex | while read -r codex_home; do
    mkdir -p "${codex_home}"
    for file in config.toml mcp.json; do
      source_file="/home/claude/.codex/${file}"
      target_file="${codex_home}/${file}"
      if [ -e "${source_file}" ]; then
        if [ -L "${target_file}" ] || [ -e "${target_file}" ]; then
          rm -f "${target_file}"
        fi
        ln -s "${source_file}" "${target_file}"
      fi
    done
    if [ -f "${codex_home}/auth.json" ]; then
      chmod 600 "${codex_home}/auth.json" || true
    fi
  done
fi

for dir in source-quality source-telemetry; do
  if [ -d "${TMP_DIR}/${dir}" ]; then
    rm -rf "${REMOTE_APP_DIR}/data/${dir}"
    cp -a "${TMP_DIR}/${dir}" "${REMOTE_APP_DIR}/data/${dir}"
  fi
done

echo "[apply] sqlite tables:"
sqlite_tables "${REMOTE_APP_DIR}/data/runtime.db"

echo "[apply] sqlite quick_check:"
sqlite_quick_check "${REMOTE_APP_DIR}/data/runtime.db"

echo "[apply] workspace AGENTS:"
find "${WORKSPACE_DIR}" -maxdepth 2 -name AGENTS.md -print | sed -n '1,40p'

echo "[apply] workspace Codex config links:"
find "${WORKSPACE_DIR}" -mindepth 2 -maxdepth 2 -path "*/.codex/config.toml" -exec ls -l {} \; | sed -n '1,40p'

echo "[apply] done. restart with: pm2 restart invest-agent-mastra --update-env"
