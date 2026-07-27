#!/usr/bin/env bash

set -euo pipefail
umask 077

LABEL="com.invest-agent.volcano-workspace-backup"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SCRIPT="${REPO_ROOT}/scripts/backup-volcano-workspaces.sh"
INSTALL_ROOT="${HOME}/Library/Application Support/InvestAgent"
INSTALLED_SCRIPT="${INSTALL_ROOT}/bin/backup-volcano-workspaces.sh"
BACKUP_ROOT="${VOLCANO_BACKUP_ROOT:-/Users/combo/MyFile/my-data/backups/invest-agent/workspaces}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_ROOT="${HOME}/Library/Logs"
TMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/${LABEL}.XXXXXX")"

cleanup() {
  rm -f -- "${TMP_PLIST}"
}
trap cleanup EXIT INT TERM

[[ -x "${BACKUP_SCRIPT}" ]] || {
  printf 'backup script is not executable: %s\n' "${BACKUP_SCRIPT}" >&2
  exit 1
}

mkdir -p -- "${HOME}/Library/LaunchAgents" "${LOG_ROOT}" "${INSTALL_ROOT}/bin"
cp -- "${BACKUP_SCRIPT}" "${INSTALLED_SCRIPT}"
chmod 700 "${INSTALLED_SCRIPT}"

cat > "${TMP_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${INSTALLED_SCRIPT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VOLCANO_BACKUP_ROOT</key>
    <string>${BACKUP_ROOT}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>1</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${LOG_ROOT}/${LABEL}.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ROOT}/${LABEL}.err</string>
</dict>
</plist>
EOF

/usr/bin/plutil -lint "${TMP_PLIST}" >/dev/null
if [[ -f "${PLIST_PATH}" ]] && ! cmp -s "${TMP_PLIST}" "${PLIST_PATH}"; then
  cp -p -- "${PLIST_PATH}" "${PLIST_PATH}.backup-$(date '+%Y%m%d-%H%M%S')"
fi
cp -- "${TMP_PLIST}" "${PLIST_PATH}"
chmod 600 "${PLIST_PATH}"

/bin/launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"

printf 'installed %s at %s (daily 01:00)\n' "${LABEL}" "${PLIST_PATH}"
