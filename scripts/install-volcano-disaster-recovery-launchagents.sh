#!/usr/bin/env bash

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SCRIPT="${REPO_ROOT}/scripts/backup-volcano-disaster-recovery.sh"
SOURCE_HELPER="${REPO_ROOT}/scripts/sqlite-online-backup.mjs"
INSTALL_ROOT="${HOME}/Library/Application Support/InvestAgent/disaster-recovery"
LOG_ROOT="${HOME}/Library/Logs"
BACKUP_ROOT="${VOLCANO_DR_BACKUP_ROOT:-/Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery}"
KEY_ROOT="${VOLCANO_DR_KEY_ROOT:-${HOME}/.config/invest-agent-dr}"
TOOL_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"

[[ -x "${SOURCE_SCRIPT}" && -r "${SOURCE_HELPER}" ]] || { echo "backup files are unavailable" >&2; exit 1; }
mkdir -p -- "${INSTALL_ROOT}/scripts" "${HOME}/Library/LaunchAgents" "${LOG_ROOT}"
cp -- "${SOURCE_SCRIPT}" "${INSTALL_ROOT}/scripts/backup-volcano-disaster-recovery.sh"
cp -- "${SOURCE_HELPER}" "${INSTALL_ROOT}/scripts/sqlite-online-backup.mjs"
cp -- "${REPO_ROOT}/scripts/backup-volcano-workspaces.sh" "${INSTALL_ROOT}/scripts/backup-volcano-workspaces.sh"
chmod 700 "${INSTALL_ROOT}/scripts/backup-volcano-disaster-recovery.sh" "${INSTALL_ROOT}/scripts/backup-volcano-workspaces.sh"
chmod 600 "${INSTALL_ROOT}/scripts/sqlite-online-backup.mjs"
cp -- "${REPO_ROOT}/package.json" "${REPO_ROOT}/package-lock.json" "${INSTALL_ROOT}/"
ln -sfn "${REPO_ROOT}/node_modules" "${INSTALL_ROOT}/node_modules"

install_job() {
  local label="$1" mode="$2" hour="$3" minute="$4"
  local plist="${HOME}/Library/LaunchAgents/${label}.plist" tmp schedule
  tmp="$(mktemp "${TMPDIR:-/tmp}/${label}.XXXXXX")"
  if [[ "${hour}" = "interval" ]]; then
    schedule='<key>StartInterval</key><integer>3600</integer>'
  else
    schedule="<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>"
  fi
  cat > "${tmp}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${INSTALL_ROOT}/scripts/backup-volcano-disaster-recovery.sh</string><string>${mode}</string></array>
<key>WorkingDirectory</key><string>${INSTALL_ROOT}</string>
<key>EnvironmentVariables</key><dict>
<key>VOLCANO_DR_BACKUP_ROOT</key><string>${BACKUP_ROOT}</string>
<key>VOLCANO_DR_KEY_ROOT</key><string>${KEY_ROOT}</string>
<key>VOLCANO_DR_TOOL_COMMIT</key><string>${TOOL_COMMIT}</string>
<key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
${schedule}
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${LOG_ROOT}/${label}.out</string>
<key>StandardErrorPath</key><string>${LOG_ROOT}/${label}.err</string>
</dict></plist>
EOF
  /usr/bin/plutil -lint "${tmp}" >/dev/null
  [[ ! -f "${plist}" ]] || cp -p -- "${plist}" "${plist}.backup-$(date '+%Y%m%d-%H%M%S')"
  cp -- "${tmp}" "${plist}"
  rm -f -- "${tmp}"
  chmod 600 "${plist}"
  /bin/launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  /bin/launchctl bootstrap "gui/$(id -u)" "${plist}"
}

install_job "com.invest-agent.volcano-dr-daily" full 1 0
/bin/launchctl bootout "gui/$(id -u)/com.invest-agent.volcano-dr-hourly" 2>/dev/null || true
/bin/launchctl disable "gui/$(id -u)/com.invest-agent.volcano-dr-hourly"
echo "installed daily full disaster-recovery backup at 01:00; hourly backup disabled"
