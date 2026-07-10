#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-118.145.115.197}"
DEPLOY_USER="${DEPLOY_USER:-claude}"
REMOTE_DIR="${REMOTE_DIR:-/home/claude/invest-agent}"
PORTAL_PUBLIC_URL="${PORTAL_PUBLIC_URL:-http://118.145.115.197:22649}"
PORTAL_RELAY_URL="${PORTAL_RELAY_URL:-ws://127.0.0.1:22650/}"
PORTAL_CONNECTOR_ID_PREFIX="${PORTAL_CONNECTOR_ID_PREFIX:-volcano-prod}"
PORTAL_CONNECTOR_RUNTIME_LABEL="${PORTAL_CONNECTOR_RUNTIME_LABEL:-火山云生产}"
PORTAL_CONNECTOR_AUTO_START="${PORTAL_CONNECTOR_AUTO_START:-false}"
PORTAL_CONNECTOR_INCLUDE_ASSISTANTS="${PORTAL_CONNECTOR_INCLUDE_ASSISTANTS:-}"
PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS="${PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS:-}"

if [ -z "${PORTAL_CONNECTOR_TOKEN:-}" ]; then
  echo "[portal-env] ERROR: PORTAL_CONNECTOR_TOKEN is required" >&2
  exit 2
fi

if [ -z "${PORTAL_DISTRIBUTION_TOKEN:-}" ]; then
  echo "[portal-env] ERROR: PORTAL_DISTRIBUTION_TOKEN is required" >&2
  exit 2
fi

if [ "${PORTAL_CONNECTOR_TOKEN}" = "dev-connector-token" ] || [ "${PORTAL_DISTRIBUTION_TOKEN}" = "dev-connector-token" ]; then
  echo "[portal-env] ERROR: refusing to configure production with dev token" >&2
  exit 2
fi

if [ "${PORTAL_CONNECTOR_TOKEN}" = "${PORTAL_DISTRIBUTION_TOKEN}" ]; then
  echo "[portal-env] ERROR: connector and distribution tokens must differ" >&2
  exit 2
fi

tmpfile="$(mktemp)"
remote_tmp="/tmp/invest-agent-portal-env.$$"
trap 'rm -f "${tmpfile}"' EXIT
cat > "${tmpfile}" <<EOF
PORTAL_PUBLIC_URL=${PORTAL_PUBLIC_URL}
PORTAL_DISTRIBUTION_URL=${PORTAL_PUBLIC_URL%/}/api/internal/distribution/provision
PORTAL_DISTRIBUTION_TOKEN=${PORTAL_DISTRIBUTION_TOKEN}
PORTAL_RELAY_URL=${PORTAL_RELAY_URL}
PORTAL_CONNECTOR_TOKEN=${PORTAL_CONNECTOR_TOKEN}
PORTAL_CONNECTOR_ID_PREFIX=${PORTAL_CONNECTOR_ID_PREFIX}
PORTAL_CONNECTOR_RUNTIME_LABEL=${PORTAL_CONNECTOR_RUNTIME_LABEL}
PORTAL_CONNECTOR_AUTO_START=${PORTAL_CONNECTOR_AUTO_START}
PORTAL_CONNECTOR_INCLUDE_ASSISTANTS=${PORTAL_CONNECTOR_INCLUDE_ASSISTANTS}
PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS=${PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS}
EOF

echo "[portal-env] update ${DEPLOY_USER}@${HOST}:${REMOTE_DIR}/.env"
scp "${tmpfile}" "${DEPLOY_USER}@${HOST}:${remote_tmp}"
ssh "${DEPLOY_USER}@${HOST}" "REMOTE_DIR='${REMOTE_DIR}' PATCH_FILE='${remote_tmp}' bash" <<'EOF'
set -euo pipefail
cd "${REMOTE_DIR}"
test -f .env
cp .env ".env.backup-$(date +%Y%m%d-%H%M%S)"
python3 - <<'PY'
from pathlib import Path

env_path = Path(".env")
patch_path = Path(__import__("os").environ["PATCH_FILE"])
if not patch_path.exists():
    raise SystemExit(f"patch file missing: {patch_path}")

updates = {}
for line in patch_path.read_text().splitlines():
    if not line.strip() or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    updates[key] = value

lines = env_path.read_text().splitlines()
seen = set()
out = []
for line in lines:
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
        out.append(line)
        continue
    key = line.split("=", 1)[0]
    if key in updates:
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)

if updates.keys() - seen:
    out.append("")
    out.append("# Portal production relay")
    for key in updates:
        if key not in seen:
            out.append(f"{key}={updates[key]}")

env_path.write_text("\n".join(out) + "\n")
patch_path.unlink(missing_ok=True)
PY
chmod 600 .env
grep -E '^(PORTAL_PUBLIC_URL|PORTAL_DISTRIBUTION_URL|PORTAL_DISTRIBUTION_TOKEN|PORTAL_RELAY_URL|PORTAL_CONNECTOR_TOKEN|PORTAL_CONNECTOR_ID_PREFIX|PORTAL_CONNECTOR_RUNTIME_LABEL|PORTAL_CONNECTOR_AUTO_START|PORTAL_CONNECTOR_INCLUDE_ASSISTANTS|PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS)=' .env \
  | sed -E 's/(TOKEN=).*/\1<redacted>/'
EOF

echo "[portal-env] done. Restart when ready:"
echo "  ssh ${DEPLOY_USER}@${HOST} 'cd ${REMOTE_DIR} && pm2 restart invest-agent --update-env'"
