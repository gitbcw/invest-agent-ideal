#!/usr/bin/env bash

set -euo pipefail
umask 077

REMOTE_HOST="${VOLCANO_BACKUP_REMOTE_HOST:-claude@118.145.115.197}"
REMOTE_WORKSPACE_ROOT="${VOLCANO_BACKUP_REMOTE_ROOT:-/home/claude/invest-agent-data/workspaces}"
BACKUP_ROOT="${VOLCANO_BACKUP_ROOT:-/Users/combo/MyFile/my-data/backups/invest-agent/workspaces}"
LOCAL_SOURCE="${VOLCANO_BACKUP_LOCAL_SOURCE:-}"
WORKSPACE_ALLOWLIST="${VOLCANO_BACKUP_WORKSPACES:-111 dyk mg}"
RSYNC_BIN="${RSYNC_BIN:-/usr/bin/rsync}"
SSH_BIN="${SSH_BIN:-/usr/bin/ssh}"
MAX_VERIFY_ATTEMPTS="${VOLCANO_BACKUP_VERIFY_ATTEMPTS:-6}"
BACKUP_LABEL="${VOLCANO_BACKUP_LABEL:-$(date '+%Y-%m-%dT%H%M%S%z')}"

SNAPSHOT_ROOT="${BACKUP_ROOT}/snapshots"
MANIFEST_ROOT="${BACKUP_ROOT}/manifests"
ROOT_SENTINEL="${BACKUP_ROOT}/.invest-agent-workspace-backup-root"
LOCK_DIR="${BACKUP_ROOT}/.backup.lock"
VERIFY_OUTPUT="${BACKUP_ROOT}/.verify-${BACKUP_LABEL}-$$"
REMOTE_HASH_BEFORE="${BACKUP_ROOT}/.remote-before-${BACKUP_LABEL}-$$"
REMOTE_HASH_AFTER="${BACKUP_ROOT}/.remote-after-${BACKUP_LABEL}-$$"
LOCAL_HASHES="${BACKUP_ROOT}/.local-hashes-${BACKUP_LABEL}-$$"
STAGING_DIR=""
WORKSPACES=()
RSYNC_EXCLUDES=(
  # Unanchored patterns: .codex sandbox artifacts also appear nested inside
  # automation run dirs (e.g. .generic-automation-run-*/.codex/.tmp), and the
  # release-snapshot safety verifier rejects them at ANY depth.
  "--exclude=.sandbox-token"
  "--exclude=.codex/auth.json"
  "--exclude=.codex/logs_2.sqlite*"
  "--exclude=.codex/.tmp/"
  "--exclude=.codex/tmp/"
  "--exclude=.rsync-partial/"
  "--exclude=._*"
)

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

cleanup() {
  rm -f -- "${VERIFY_OUTPUT}" "${VERIFY_OUTPUT}.filtered" "${REMOTE_HASH_BEFORE}" "${REMOTE_HASH_AFTER}" "${LOCAL_HASHES}"
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}

validate_configuration() {
  [[ "${BACKUP_ROOT}" = /* ]] || fail "VOLCANO_BACKUP_ROOT must be absolute"
  if [[ "${BACKUP_ROOT}" = "/" || "${BACKUP_ROOT}" = "/Users" || "${BACKUP_ROOT}" = "${HOME}" ]]; then
    fail "VOLCANO_BACKUP_ROOT is too broad: ${BACKUP_ROOT}"
  fi
  [[ "${BACKUP_LABEL}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}[+-][0-9]{4}$ ]] || fail "invalid backup label: ${BACKUP_LABEL}"
  [[ "${MAX_VERIFY_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] || fail "VOLCANO_BACKUP_VERIFY_ATTEMPTS must be a positive integer"
  read -r -a WORKSPACES <<< "${WORKSPACE_ALLOWLIST}"
  [[ "${#WORKSPACES[@]}" -gt 0 ]] || fail "workspace allowlist is empty"
  local workspace
  for workspace in "${WORKSPACES[@]}"; do
    [[ "${workspace}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "invalid workspace allowlist entry: ${workspace}"
    [[ "${workspace}" != "." && "${workspace}" != ".." ]] || fail "invalid workspace allowlist entry: ${workspace}"
  done
  [[ -x "${RSYNC_BIN}" ]] || fail "rsync is unavailable: ${RSYNC_BIN}"
  if [[ -z "${LOCAL_SOURCE}" ]]; then
    [[ -x "${SSH_BIN}" ]] || fail "ssh is unavailable: ${SSH_BIN}"
    [[ "${REMOTE_WORKSPACE_ROOT}" = /* ]] || fail "remote workspace root must be absolute"
  else
    [[ "${LOCAL_SOURCE}" = /* ]] || fail "VOLCANO_BACKUP_LOCAL_SOURCE must be absolute"
    [[ -d "${LOCAL_SOURCE}" ]] || fail "local source does not exist: ${LOCAL_SOURCE}"
  fi
}

initialize_backup_root() {
  mkdir -p -- "${BACKUP_ROOT}"
  if [[ ! -f "${ROOT_SENTINEL}" ]]; then
    if find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
      fail "backup root is not initialized and is not empty: ${BACKUP_ROOT}"
    fi
    : > "${ROOT_SENTINEL}"
  fi
  mkdir -p -- "${SNAPSHOT_ROOT}" "${MANIFEST_ROOT}"
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    fail "another workspace backup is already running"
  fi
  trap cleanup EXIT INT TERM
}

rsync_source() {
  local workspace="$1"
  if [[ -n "${LOCAL_SOURCE}" ]]; then
    printf '%s/%s/' "${LOCAL_SOURCE%/}" "${workspace}"
  else
    printf '%s:%s/%s/' "${REMOTE_HOST}" "${REMOTE_WORKSPACE_ROOT%/}" "${workspace}"
  fi
}

run_rsync() {
  local dry_run="$1"
  local workspace="$2"
  local source
  local args=(-rlpt --delete --delete-delay "${RSYNC_EXCLUDES[@]}")
  local destination="${STAGING_DIR}/${workspace}"
  source="$(rsync_source "${workspace}")"
  mkdir -p -- "${destination}"

  if [[ "${dry_run}" = "true" ]]; then
    args+=(-n --itemize-changes)
  else
    args+=(-z --partial-dir=.rsync-partial)
    if [[ -L "${BACKUP_ROOT}/latest" ]]; then
      local latest_target
      latest_target="$(readlink "${BACKUP_ROOT}/latest")"
      case "${latest_target}" in
        snapshots/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*)
          if [[ -d "${BACKUP_ROOT}/${latest_target}" ]]; then
            if [[ -d "${BACKUP_ROOT}/${latest_target}/${workspace}" ]]; then
              args+=(--link-dest="${BACKUP_ROOT}/${latest_target}/${workspace}")
            fi
          fi
          ;;
      esac
    fi
  fi

  if [[ -n "${LOCAL_SOURCE}" ]]; then
    "${RSYNC_BIN}" "${args[@]}" "${source}" "${destination}/"
  else
    local remote_shell
    remote_shell="${SSH_BIN} -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"
    "${RSYNC_BIN}" "${args[@]}" -e "${remote_shell}" "${source}" "${destination}/"
  fi
}

clean_excluded_from_staging() {
  local workspace workspace_dir
  for workspace in "${WORKSPACES[@]}"; do
    workspace_dir="${STAGING_DIR}/${workspace}"
    [[ -d "${workspace_dir}" ]] || continue
    # Depth-agnostic: automation run dirs carry their own nested .codex
    # sandboxes; staging filters must stay aligned with the unanchored rsync
    # excludes and the release-snapshot safety verifier.
    find "${workspace_dir}" -type f -name '.sandbox-token' -delete
    find "${workspace_dir}" -depth -name '.rsync-partial' -type d -delete
    find "${workspace_dir}" -depth -name '._*' -delete
    find "${workspace_dir}" -type f -path '*/.codex/auth.json' -delete
    find "${workspace_dir}" -type f -path '*/.codex/logs_2.sqlite*' -delete
    find "${workspace_dir}" -depth -type d -path '*/.codex/.tmp' -delete
    find "${workspace_dir}" -depth -type d -path '*/.codex/tmp' -delete
  done
}

write_remote_hashes() {
  local output="$1"
  local workspace
  : > "${output}"
  for workspace in "${WORKSPACES[@]}"; do
    printf 'workspace=%s\n' "${workspace}" >> "${output}"
    if [[ -n "${LOCAL_SOURCE}" ]]; then
      (
        cd "${LOCAL_SOURCE}/${workspace}"
        find . \
          \( -path '*/.codex/.tmp' -o -path '*/.codex/tmp' -o -name '.rsync-partial' -o -name '._*' \) -prune -o \
          -type f ! -name '.sandbox-token' ! -path '*/.codex/auth.json' ! -path '*/.codex/logs_2.sqlite*' -print0 \
          | LC_ALL=C sort -z | xargs -0 shasum -a 256
      ) >> "${output}"
    else
      "${SSH_BIN}" -o BatchMode=yes -o ConnectTimeout=15 "${REMOTE_HOST}" \
        "cd '${REMOTE_WORKSPACE_ROOT}/${workspace}' && find . \\
          \\( -path '*/.codex/.tmp' -o -path '*/.codex/tmp' -o -name '.rsync-partial' -o -name '._*' \\) -prune -o \\
          -type f ! -name '.sandbox-token' ! -path '*/.codex/auth.json' ! -path '*/.codex/logs_2.sqlite*' -print0 \\
          | LC_ALL=C sort -z | xargs -0 sha256sum" \
        >> "${output}"
    fi
  done
}

write_local_hashes() {
  local output="$1"
  local workspace
  : > "${output}"
  for workspace in "${WORKSPACES[@]}"; do
    printf 'workspace=%s\n' "${workspace}" >> "${output}"
    (
      cd "${STAGING_DIR}/${workspace}"
      find . \
        \( -path '*/.codex/.tmp' -o -path '*/.codex/tmp' -o -name '.rsync-partial' -o -name '._*' \) -prune -o \
        -type f ! -name '.sandbox-token' ! -path '*/.codex/auth.json' ! -path '*/.codex/logs_2.sqlite*' -print0 \
        | LC_ALL=C sort -z | xargs -0 shasum -a 256
    ) >> "${output}"
  done
}

verify_and_publish() {
  local final_dir="${SNAPSHOT_ROOT}/${BACKUP_LABEL}"
  local attempt=1
  local verified="false"
  [[ ! -e "${final_dir}" ]] || fail "snapshot already exists: ${final_dir}"
  STAGING_DIR="${SNAPSHOT_ROOT}/.incomplete-current"
  mkdir -p -- "${STAGING_DIR}"

  while (( attempt <= MAX_VERIFY_ATTEMPTS )); do
    log "sync attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}"
    clean_excluded_from_staging
    local workspace
    for workspace in "${WORKSPACES[@]}"; do
      run_rsync false "${workspace}"
    done
    : > "${VERIFY_OUTPUT}"
    for workspace in "${WORKSPACES[@]}"; do
      run_rsync true "${workspace}" >> "${VERIFY_OUTPUT}"
    done
    # Directory mtimes can move while a live workspace is being written. File,
    # link, create, and delete differences remain blocking and are hash-checked.
    awk '$1 != ".d..t...."' "${VERIFY_OUTPUT}" > "${VERIFY_OUTPUT}.filtered"
    mv -- "${VERIFY_OUTPUT}.filtered" "${VERIFY_OUTPUT}"
    if [[ -s "${VERIFY_OUTPUT}" ]]; then
      log "source changed during metadata verification; retrying ($(wc -l < "${VERIFY_OUTPUT}" | tr -d ' ') differences)"
      attempt=$((attempt + 1))
      continue
    fi

    write_remote_hashes "${REMOTE_HASH_BEFORE}"
    write_local_hashes "${LOCAL_HASHES}"
    write_remote_hashes "${REMOTE_HASH_AFTER}"
    if cmp -s "${REMOTE_HASH_BEFORE}" "${LOCAL_HASHES}" && cmp -s "${REMOTE_HASH_BEFORE}" "${REMOTE_HASH_AFTER}"; then
      verified="true"
      break
    fi
    log "content hashes changed or did not match during verification; retrying"
    attempt=$((attempt + 1))
  done

  [[ "${verified}" = "true" ]] || fail "source did not stabilize after ${MAX_VERIFY_ATTEMPTS} attempts"
  mv -- "${STAGING_DIR}" "${final_dir}"
  STAGING_DIR=""

  local file_count directory_count symlink_count size_kib content_manifest_sha256
  file_count="$(find "${final_dir}" -type f | wc -l | tr -d ' ')"
  directory_count="$(find "${final_dir}" -type d | wc -l | tr -d ' ')"
  symlink_count="$(find "${final_dir}" -type l | wc -l | tr -d ' ')"
  size_kib="$(du -sk "${final_dir}" | awk '{print $1}')"
  content_manifest_sha256="$(shasum -a 256 "${LOCAL_HASHES}" | awk '{print $1}')"
  {
    printf 'snapshot=%s\n' "${BACKUP_LABEL}"
    printf 'completed_at=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'source=%s\n' "${LOCAL_SOURCE:+local-test}${LOCAL_SOURCE:-volcano-workspaces}"
    printf 'verification=rsync-metadata-dry-run-clean+sha256-manifest-match\n'
    printf 'content_manifest_sha256=%s\n' "${content_manifest_sha256}"
    printf 'workspaces=%s\n' "$(IFS=,; printf '%s' "${WORKSPACES[*]}")"
    printf 'excluded=.sandbox-token,.codex/auth.json,.codex/logs_2.sqlite*,.codex/.tmp,.codex/tmp,.rsync-partial,._*\n'
    printf 'files=%s\n' "${file_count}"
    printf 'directories=%s\n' "${directory_count}"
    printf 'symlinks=%s\n' "${symlink_count}"
    printf 'size_kib=%s\n' "${size_kib}"
  } > "${MANIFEST_ROOT}/${BACKUP_LABEL}.txt"

  ln -sfn "snapshots/${BACKUP_LABEL}" "${BACKUP_ROOT}/latest"
  log "published snapshot ${BACKUP_LABEL}: files=${file_count} size_kib=${size_kib}"
}

prune_old_days() {
  local days_file="${BACKUP_ROOT}/.days-$$"
  local snapshot name old_day
  : > "${days_file}"
  for snapshot in "${SNAPSHOT_ROOT}"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*; do
    [[ -d "${snapshot}" ]] || continue
    name="$(basename "${snapshot}")"
    [[ "${name}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}[+-][0-9]{4}$ ]] || continue
    printf '%s\n' "${name:0:10}" >> "${days_file}"
  done

  sort -ru "${days_file}" | awk 'NR > 3' | while IFS= read -r old_day; do
    [[ -n "${old_day}" ]] || continue
    for snapshot in "${SNAPSHOT_ROOT}/${old_day}T"*; do
      [[ -d "${snapshot}" ]] || continue
      name="$(basename "${snapshot}")"
      [[ "${name}" =~ ^${old_day}T[0-9]{6}[+-][0-9]{4}$ ]] || fail "refusing to prune unexpected snapshot: ${snapshot}"
      [[ "$(dirname "${snapshot}")" = "${SNAPSHOT_ROOT}" ]] || fail "refusing to prune outside snapshot root"
      rm -rf -- "${snapshot}"
      rm -f -- "${MANIFEST_ROOT}/${name}.txt"
      log "pruned snapshot ${name}"
    done
  done
  rm -f -- "${days_file}"
}

main() {
  validate_configuration
  initialize_backup_root
  if [[ -z "${LOCAL_SOURCE}" ]]; then
    local workspace
    for workspace in "${WORKSPACES[@]}"; do
      "${SSH_BIN}" -o BatchMode=yes -o ConnectTimeout=15 "${REMOTE_HOST}" \
        "test -d '${REMOTE_WORKSPACE_ROOT}/${workspace}' && test -r '${REMOTE_WORKSPACE_ROOT}/${workspace}' && command -v rsync >/dev/null && command -v sha256sum >/dev/null"
    done
  else
    local workspace
    for workspace in "${WORKSPACES[@]}"; do
      [[ -d "${LOCAL_SOURCE}/${workspace}" ]] || fail "allowlisted local workspace does not exist: ${workspace}"
    done
  fi
  verify_and_publish
  prune_old_days
  log "workspace backup completed"
}

main "$@"
