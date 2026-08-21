#!/usr/bin/env bash

set -euo pipefail
umask 077

MODE="${1:-full}"
REMOTE_HOST="${VOLCANO_DR_REMOTE_HOST:-claude@118.145.115.197}"
REMOTE_RUNTIME_DIR="${VOLCANO_DR_RUNTIME_DIR:-/home/claude/invest-agent-mastra}"
REMOTE_PORTAL_DIR="${VOLCANO_DR_PORTAL_DIR:-/home/claude/invest-agent-mastra/apps/portal}"
# 真实用户工作区（111/dyk/mg）仍在旧独立数据根；mastra .env 的 WORKSPACE_ROOT
# 指向 data/workspaces 但该目录截至 2026-08-21 不存在（见 docs 巡查记录）。
REMOTE_WORKSPACE_ROOT="${VOLCANO_DR_WORKSPACE_ROOT:-/home/claude/invest-agent-data/workspaces}"
BACKUP_ROOT="${VOLCANO_DR_BACKUP_ROOT:-/Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery}"
KEY_ROOT="${VOLCANO_DR_KEY_ROOT:-${HOME}/.config/invest-agent-dr}"
BACKUP_LABEL="${VOLCANO_DR_LABEL:-$(date '+%Y-%m-%dT%H%M%S%z')}"
SSH_BIN="${SSH_BIN:-/usr/bin/ssh}"
RSYNC_BIN="${RSYNC_BIN:-/usr/bin/rsync}"
OPENSSL_BIN="${OPENSSL_BIN:-/usr/bin/openssl}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQLITE_HELPER="${REPO_ROOT}/scripts/sqlite-online-backup.mjs"
WORKSPACE_BACKUP="${REPO_ROOT}/scripts/backup-volcano-workspaces.sh"
ROOT_SENTINEL="${BACKUP_ROOT}/.invest-agent-dr-backup-root"
LOCK_DIR="${BACKUP_ROOT}/.backup.lock"
SNAPSHOT_KIND=""
SNAPSHOT_ROOT=""
STAGING_DIR=""
FINAL_DIR=""
REMOTE_STAGE="${REMOTE_RUNTIME_DIR}/.backup/disaster-recovery/${BACKUP_LABEL}"
PRIVATE_KEY="${KEY_ROOT}/private.pem"
PUBLIC_KEY="${KEY_ROOT}/public.pem"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

cleanup() {
  "${SSH_BIN}" -o BatchMode=yes -o ConnectTimeout=15 "${REMOTE_HOST}" "rm -rf -- '${REMOTE_STAGE}'" >/dev/null 2>&1 || true
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}

validate_configuration() {
  case "${MODE}" in hourly|full) ;; *) fail "mode must be hourly or full" ;; esac
  [[ "${BACKUP_ROOT}" = /* && "${KEY_ROOT}" = /* ]] || fail "backup and key roots must be absolute"
  [[ "${BACKUP_ROOT}" != "${KEY_ROOT}" && "${KEY_ROOT}" != "${BACKUP_ROOT}"/* ]] || fail "key root must be outside backup root"
  [[ "${BACKUP_LABEL}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}[+-][0-9]{4}$ ]] || fail "invalid backup label"
  [[ -x "${SSH_BIN}" && -x "${RSYNC_BIN}" && -x "${OPENSSL_BIN}" ]] || fail "required tool is unavailable"
  [[ -r "${SQLITE_HELPER}" ]] || fail "SQLite helper is unavailable"
  if [[ "${MODE}" = "full" ]]; then [[ -x "${WORKSPACE_BACKUP}" ]] || fail "workspace backup script is unavailable"; fi
}

initialize() {
  mkdir -p -- "${BACKUP_ROOT}"
  if [[ ! -f "${ROOT_SENTINEL}" ]]; then
    if find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
      fail "backup root is not initialized and is not empty"
    fi
    : > "${ROOT_SENTINEL}"
  fi
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then fail "another disaster-recovery backup is running"; fi
  trap cleanup EXIT INT TERM
  SNAPSHOT_KIND="${MODE}"
  SNAPSHOT_ROOT="${BACKUP_ROOT}/${SNAPSHOT_KIND}"
  STAGING_DIR="${SNAPSHOT_ROOT}/.incomplete-${BACKUP_LABEL}"
  FINAL_DIR="${SNAPSHOT_ROOT}/${BACKUP_LABEL}"
  [[ ! -e "${FINAL_DIR}" ]] || fail "snapshot already exists"
  mkdir -p -- "${STAGING_DIR}/databases"
}

ensure_encryption_key() {
  mkdir -p -- "${KEY_ROOT}"
  chmod 700 "${KEY_ROOT}"
  if [[ ! -f "${PRIVATE_KEY}" ]]; then
    "${OPENSSL_BIN}" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${PRIVATE_KEY}" >/dev/null 2>&1
    chmod 600 "${PRIVATE_KEY}"
  fi
  if [[ ! -f "${PUBLIC_KEY}" ]]; then
    "${OPENSSL_BIN}" pkey -in "${PRIVATE_KEY}" -pubout -out "${PUBLIC_KEY}" >/dev/null 2>&1
    chmod 644 "${PUBLIC_KEY}"
  fi
  "${OPENSSL_BIN}" pkey -in "${PRIVATE_KEY}" -pubout -outform DER 2>/dev/null | shasum -a 256 | awk '{print $1}' > "${STAGING_DIR}/encryption-key-fingerprint.txt"
}

remote_preflight() {
  # 新门户共用 runtime.db（PORTAL_DB_PATH 同库），不再有独立 portal.db。
  "${SSH_BIN}" -o BatchMode=yes -o ConnectTimeout=15 "${REMOTE_HOST}" \
    "test -r '${REMOTE_RUNTIME_DIR}/data/runtime.db' && test -d '${REMOTE_WORKSPACE_ROOT}' && command -v node >/dev/null && command -v rsync >/dev/null && command -v openssl >/dev/null && mkdir -p '${REMOTE_STAGE}'"
}

backup_remote_sqlite() {
  local cwd="$1" source="$2" destination="$3" local_name="$4" result
  result="$("${SSH_BIN}" -o BatchMode=yes "${REMOTE_HOST}" "cd '${cwd}' && node --input-type=module - '${source}' '${destination}'" < "${SQLITE_HELPER}")"
  [[ "${result}" = *'"quickCheck":"ok"'* ]] || fail "remote SQLite backup failed for ${local_name}"
  "${RSYNC_BIN}" -a -e "${SSH_BIN} -o BatchMode=yes" "${REMOTE_HOST}:${destination}" "${STAGING_DIR}/databases/${local_name}"
  local local_check
  local_check="$(cd "${REPO_ROOT}" && node "${SQLITE_HELPER}" "${STAGING_DIR}/databases/${local_name}" "${STAGING_DIR}/databases/.verify-${local_name}")"
  rm -f -- \
    "${STAGING_DIR}/databases/.verify-${local_name}" \
    "${STAGING_DIR}/databases/.verify-${local_name}-wal" \
    "${STAGING_DIR}/databases/.verify-${local_name}-shm" \
    "${STAGING_DIR}/databases/${local_name}-wal" \
    "${STAGING_DIR}/databases/${local_name}-shm"
  [[ "${local_check}" = *'"quickCheck":"ok"'* ]] || fail "local SQLite verification failed for ${local_name}"
  printf '%s remote=%s local=%s\n' "${local_name}" "${result}" "${local_check}" >> "${STAGING_DIR}/sqlite-checks.txt"
}

sync_tree() {
  local source="$1" destination="$2"; shift 2
  local args=(-rlptz --delete --delete-delay --partial) verify_args=(-rlptn --delete --itemize-changes)
  local item
  while (( "$#" )); do
    item="$1"
    shift
    args+=("--exclude=${item}")
    verify_args+=("--exclude=${item}")
  done
  mkdir -p -- "${destination}"
  "${RSYNC_BIN}" "${args[@]}" -e "${SSH_BIN} -o BatchMode=yes" "${REMOTE_HOST}:${source%/}/" "${destination}/"
  local verify_file="${STAGING_DIR}/.rsync-verify-$$"
  "${RSYNC_BIN}" "${verify_args[@]}" -e "${SSH_BIN} -o BatchMode=yes" "${REMOTE_HOST}:${source%/}/" "${destination}/" > "${verify_file}"
  awk '$1 != ".d..t...."' "${verify_file}" > "${verify_file}.filtered"
  [[ ! -s "${verify_file}.filtered" ]] || fail "source changed during rsync verification: ${source}"
  rm -f -- "${verify_file}" "${verify_file}.filtered"
}

backup_full_data() {
  VOLCANO_BACKUP_REMOTE_HOST="${REMOTE_HOST}" \
  VOLCANO_BACKUP_REMOTE_ROOT="${REMOTE_WORKSPACE_ROOT}" \
  VOLCANO_BACKUP_ROOT="${STAGING_DIR}/workspaces" \
  VOLCANO_BACKUP_LABEL="${BACKUP_LABEL}" \
    "${WORKSPACE_BACKUP}"

  # 新布局 reviews 在 data/reviews（顶级无 reviews）；runtime-data 同步排除以免重复。
  sync_tree "${REMOTE_RUNTIME_DIR}/data/reviews" "${STAGING_DIR}/reviews" '._*'
  sync_tree "${REMOTE_RUNTIME_DIR}/data" "${STAGING_DIR}/runtime-data" '*.db' '*.db-*' 'test-*' 'cache/' 'backups/' '/reviews/' '.sandbox-secret' '._*'
  sync_tree "${REMOTE_RUNTIME_DIR}" "${STAGING_DIR}/runtime-code" '.git/' '.env*' '.state/' '.codex/' '.backup/' 'node_modules/' 'data/' 'workspaces/' 'reviews/' 'logs/' 'tmp/'
  sync_tree "${REMOTE_PORTAL_DIR}" "${STAGING_DIR}/portal-code" '.git/' '.env*' 'node_modules/' '.next/' 'data/' 'logs/' 'backups/'
}

backup_encrypted_sensitive_state() {
  "${RSYNC_BIN}" -a -e "${SSH_BIN} -o BatchMode=yes" "${PUBLIC_KEY}" "${REMOTE_HOST}:${REMOTE_STAGE}/public.pem"
  "${SSH_BIN}" -o BatchMode=yes "${REMOTE_HOST}" "REMOTE_STAGE='${REMOTE_STAGE}' RUNTIME_DIR='${REMOTE_RUNTIME_DIR}' PORTAL_DIR='${REMOTE_PORTAL_DIR}' bash -s" <<'EOF'
set -euo pipefail
umask 077
key_file="${REMOTE_STAGE}/data-key.hex"
cleanup() { rm -f -- "${key_file}"; }
trap cleanup EXIT INT TERM
openssl rand -hex 32 > "${key_file}"
files=()
[[ -f "${RUNTIME_DIR}/.env" ]] && files+=("${RUNTIME_DIR#/}/.env")
[[ -d "${RUNTIME_DIR}/.state" ]] && files+=("${RUNTIME_DIR#/}/.state")
[[ -f "${RUNTIME_DIR}/data/.sandbox-secret" ]] && files+=("${RUNTIME_DIR#/}/data/.sandbox-secret")
[[ -f "${PORTAL_DIR}/.env" ]] && files+=("${PORTAL_DIR#/}/.env")
[[ -f /home/claude/.codex/auth.json ]] && files+=("home/claude/.codex/auth.json")
[[ -f /home/claude/.codex/config.toml ]] && files+=("home/claude/.codex/config.toml")
[[ -f /home/claude/.codex/installation_id ]] && files+=("home/claude/.codex/installation_id")
[[ "${#files[@]}" -gt 0 ]]
tar -C / -czf - "${files[@]}" | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass file:"${key_file}" -out "${REMOTE_STAGE}/sensitive.tar.gz.enc"
openssl pkeyutl -encrypt -pubin -inkey "${REMOTE_STAGE}/public.pem" -in "${key_file}" -out "${REMOTE_STAGE}/data-key.enc" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256
rm -f -- "${REMOTE_STAGE}/public.pem"
EOF
  mkdir -p -- "${STAGING_DIR}/sensitive"
  "${RSYNC_BIN}" -a -e "${SSH_BIN} -o BatchMode=yes" "${REMOTE_HOST}:${REMOTE_STAGE}/sensitive.tar.gz.enc" "${STAGING_DIR}/sensitive/"
  "${RSYNC_BIN}" -a -e "${SSH_BIN} -o BatchMode=yes" "${REMOTE_HOST}:${REMOTE_STAGE}/data-key.enc" "${STAGING_DIR}/sensitive/"
}

write_manifest_and_publish() {
  local git_commit remote_release
  git_commit="${VOLCANO_DR_TOOL_COMMIT:-$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || printf 'unknown')}"
  remote_release="$("${SSH_BIN}" -o BatchMode=yes "${REMOTE_HOST}" "cd '${REMOTE_RUNTIME_DIR}' && (git rev-parse HEAD 2>/dev/null || sed -n 's/^commit=//p' .deploy/release.json 2>/dev/null | head -n 1 || true)")"
  (
    cd "${STAGING_DIR}"
    find . -type f ! -name manifest.sha256 ! -name metadata.txt ! -name COMPLETE -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 > manifest.sha256
  )
  {
    printf 'backup_id=%s\n' "${BACKUP_LABEL}"
    printf 'mode=%s\n' "${MODE}"
    printf 'started_at=%s\n' "${BACKUP_LABEL}"
    printf 'completed_at=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'source=%s\n' "${REMOTE_HOST}"
    printf 'local_tool_commit=%s\n' "${git_commit}"
    printf 'remote_release=%s\n' "${remote_release:-unknown}"
    printf 'sqlite_verification=quick_check_ok\n'
    printf 'sensitive_encryption=aes-256-cbc-pbkdf2+rsa-oaep-sha256\n'
    printf 'files=%s\n' "$(find "${STAGING_DIR}" -type f | wc -l | tr -d ' ')"
    printf 'size_kib=%s\n' "$(du -sk "${STAGING_DIR}" | awk '{print $1}')"
    printf 'status=complete\n'
  } > "${STAGING_DIR}/metadata.txt"
  : > "${STAGING_DIR}/COMPLETE"
  mv -- "${STAGING_DIR}" "${FINAL_DIR}"
  STAGING_DIR=""
  ln -sfn "${SNAPSHOT_KIND}/${BACKUP_LABEL}" "${BACKUP_ROOT}/latest-${SNAPSHOT_KIND}"
}

prune_snapshots() {
  local keep="$1" path
  find "${SNAPSHOT_ROOT}" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??T??????[+-]????' -print | LC_ALL=C sort -r | awk -v keep="${keep}" 'NR > keep' | while IFS= read -r path; do
    [[ "$(dirname "${path}")" = "${SNAPSHOT_ROOT}" ]] || fail "refusing to prune outside snapshot root"
    rm -rf -- "${path}"
  done
}

main() {
  validate_configuration
  initialize
  ensure_encryption_key
  remote_preflight
  backup_remote_sqlite "${REMOTE_RUNTIME_DIR}" "${REMOTE_RUNTIME_DIR}/data/runtime.db" "${REMOTE_STAGE}/runtime.db" "runtime.db"
  # 遗留独立门户库（切换前旧门户的 data/portal.db）：存在才备份。
  if "${SSH_BIN}" -o BatchMode=yes "${REMOTE_HOST}" "test -f '${REMOTE_RUNTIME_DIR}/data/portal.db'"; then
    backup_remote_sqlite "${REMOTE_RUNTIME_DIR}" "${REMOTE_RUNTIME_DIR}/data/portal.db" "${REMOTE_STAGE}/legacy-portal.db" "legacy-portal.db"
  fi
  if [[ "${MODE}" = "full" ]]; then
    backup_full_data
    backup_encrypted_sensitive_state
  fi
  write_manifest_and_publish
  if [[ "${MODE}" = "hourly" ]]; then prune_snapshots 48; else prune_snapshots 14; fi
  log "published ${MODE} disaster-recovery backup ${BACKUP_LABEL}"
}

main "$@"
