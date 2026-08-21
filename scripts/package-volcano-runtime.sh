#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-data/runtime.db}"
RUNTIME_DATA_ROOT="${RUNTIME_DATA_ROOT:-data}"
REVIEWS_DIR="${REVIEWS_DIR:-reviews}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces}"
OUT_DIR="${OUT_DIR:-.tmp/volcano-migration}"
STAMP="$(date +%Y%m%d-%H%M%S)"
PACKAGE_NAME="${PACKAGE_NAME:-invest-agent-runtime-${STAMP}.tgz}"

if [ "${CONFIRM_PRODUCTION_STOPPED:-}" != "true" ]; then
  cat >&2 <<'EOF'
[package] Refusing to package a production snapshot until writes are frozen.
[package] Stop the local production service/connector first, then rerun with:
[package]   CONFIRM_PRODUCTION_STOPPED=true scripts/package-volcano-runtime.sh
EOF
  exit 2
fi

if [ ! -f "${DB_PATH}" ]; then
  echo "[package] DB not found: ${DB_PATH}" >&2
  exit 1
fi

if [ ! -d "${WORKSPACE_ROOT}" ]; then
  echo "[package] workspace root not found: ${WORKSPACE_ROOT}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

if command -v sqlite3 >/dev/null 2>&1; then
  echo "[package] checkpoint sqlite WAL: ${DB_PATH}"
  sqlite3 "${DB_PATH}" 'PRAGMA wal_checkpoint(TRUNCATE);'
else
  echo "[package] WARN: sqlite3 not found; package will include WAL/SHM if present" >&2
fi

DB_DIR="$(cd "$(dirname "${DB_PATH}")" && pwd)"
DB_FILE="$(basename "${DB_PATH}")"
OUT_DIR_ABS="$(cd "${OUT_DIR}" && pwd)"
PACKAGE_PATH="${OUT_DIR_ABS}/${PACKAGE_NAME}"

echo "[package] create ${PACKAGE_PATH}"
tar_args=(-C "${DB_DIR}" "${DB_FILE}")
for suffix in wal shm; do
  if [ -f "${DB_DIR}/${DB_FILE}-${suffix}" ]; then
    tar_args+=(-C "${DB_DIR}" "${DB_FILE}-${suffix}")
  fi
done

if [ -d "${REVIEWS_DIR}" ]; then
  reviews_parent="$(cd "$(dirname "${REVIEWS_DIR}")" && pwd)"
  tar_args+=(-C "${reviews_parent}" "$(basename "${REVIEWS_DIR}")")
fi

runtime_root_abs="$(cd "${RUNTIME_DATA_ROOT}" && pwd)"
for dir in source-quality source-telemetry; do
  if [ -d "${runtime_root_abs}/${dir}" ]; then
    tar_args+=(-C "${runtime_root_abs}" "${dir}")
  fi
done

workspace_parent="$(cd "$(dirname "${WORKSPACE_ROOT}")" && pwd)"
tar_args+=(-C "${workspace_parent}" "$(basename "${WORKSPACE_ROOT}")")

tar czf "${PACKAGE_PATH}" "${tar_args[@]}"

echo "[package] done: ${PACKAGE_PATH}"
echo "[package] upload example:"
echo "  scp ${PACKAGE_PATH} claude@118.145.115.197:/home/claude/"
