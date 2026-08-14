# Production Runbook

This runbook covers current `invest-agent-portal` production operation.

## Current Production Deployments

### Volcano Cloud

The active Volcano Cloud portal is fixed at:

- SSH target: `claude@118.145.115.197`
- Deployment directory: `/home/claude/invest-agent-portal`
- Browser URL: `http://118.145.115.197:22649`
- Relay / connector URL: `ws://127.0.0.1:22650/` for the co-located Volcano `invest-agent` runtime
- Runtime model: PM2 custom server
- PM2 process: `invest-agent-portal`

Port meanings:

- Volcano `22649` is the public user portal HTTP port.
- Volcano `22650` is the local WebSocket Relay port used by the co-located connector.
- Volcano `22655` belongs to the separate `invest-agent` runtime, not this portal app.
- Local Mac `22648` is the recommended SSH tunnel for Platform admin access: `ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197`, then open `http://127.0.0.1:22648/platform`.
- Local Mac `22649` should stay free or be treated as the public portal port number only; do not use it for Platform tunnel.

For code updates on this deployment, run:

```bash
npm run deploy:volcano
```

The deploy script preserves the remote `.env` and `data/`, then installs, builds, restarts PM2, and verifies `http://118.145.115.197:22649/login`.

### Aliyun Deployment

The legacy Aliyun portal deployment is fixed at:

- SSH target: `admin@47.107.151.70`
- Deployment directory: `/home/admin/invest-agent-portal`
- Browser URL: `http://47.107.151.70:8088`
- Relay / connector URL: `ws://47.107.151.70:18088/`
- Runtime model: Docker Compose
- Containers: `invest-agent-portal`, `invest-agent-portal-nginx`

Port meanings:

- `8088` is the public web portal address.
- `18088` is the public WebSocket Relay address used by the invest-agent connector.
- `22655` is not part of this portal container deployment; it is the invest-agent platform service port.

For code updates on this existing deployment, sync this repository to `/home/admin/invest-agent-portal` while preserving `.env.production` and `data/`, then run:

```bash
npm run deploy:aliyun
```

The deploy script preserves `.env.production` and `data/`, then runs Docker Compose on the server.

## Process Model

Run Portal with the custom server only:

```bash
npm ci
npm run build
NODE_ENV=production npm run start
```

The custom server starts both:

- Next.js HTTP/API on `PORTAL_PORT`, default `3100`
- WebSocket Relay on `PORTAL_RELAY_PORT`, default `3199`

Do not run `scripts/start-relay.ts` as a separate production process. The HTTP API and Relay share the in-process connector registry; splitting them makes assistants appear offline.

## Required Environment

Create a production env file outside source control, for example `/etc/invest-agent-portal.env`:

```bash
NODE_ENV=production
PORTAL_PORT=3100
PORTAL_RELAY_PORT=3199
PORTAL_DB_PATH=/var/lib/invest-agent-portal/portal.db
PORTAL_JWT_SECRET=<openssl rand -hex 32>
PORTAL_CONNECTOR_TOKEN=<openssl rand -hex 32>
PORTAL_DISTRIBUTION_TOKEN=<different openssl rand -hex 32>
PORTAL_COOKIE_NAME=portal_session
PORTAL_COOKIE_SECURE=0
PORTAL_SESSION_TTL_SEC=2592000
PORTAL_EXECUTION_BUDGET_MS=1200000
PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS=1215000
PORTAL_DEFAULT_ASSISTANT_ID=invest-agent-primary
PORTAL_DEFAULT_INSTANCE_ID=invest-agent-primary
PORTAL_DEFAULT_PROJECT_ID=invest-agent
```

The checked-in `.env.production.example` is only a template. Real environment files stay on their production servers.

Rules:

- `PORTAL_JWT_SECRET` must not be the development default.
- `PORTAL_CONNECTOR_TOKEN` must not be the development default.
- `PORTAL_DISTRIBUTION_TOKEN` must not be the development default.
- `PORTAL_DISTRIBUTION_TOKEN` must differ from `PORTAL_CONNECTOR_TOKEN`.
- Keep `/var/lib/invest-agent-portal` persistent and backed up.
- Volcano fixed-IP HTTP production requires `PORTAL_COOKIE_SECURE=0`. This is the supported baseline, not a temporary fallback. A separate deployment with a filed domain and TLS may use `PORTAL_COOKIE_SECURE=1`.

## PM2

Example:

```bash
cd /opt/invest-agent-portal
set -a
. /etc/invest-agent-portal.env
set +a
npm ci
npm run build
pm2 start npm --name invest-agent-portal -- run start
pm2 save
pm2 status
```

Restart after code updates:

```bash
cd /opt/invest-agent-portal
git pull
npm ci
npm run build
pm2 restart invest-agent-portal --update-env
```

## Optional TLS Reverse Proxy

This section applies only to deployments that have a filed domain and certificate. It is not a prerequisite for Volcano fixed-IP HTTP production. When TLS is available, terminate it at Nginx or Caddy and proxy both browser HTTP and Relay WebSocket.

### Nginx Example

```nginx
server {
  listen 443 ssl http2;
  server_name portal.example.com;

  ssl_certificate /etc/letsencrypt/live/portal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/portal.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 1230s;
    proxy_send_timeout 1230s;
  }
}

server {
  listen 443 ssl http2;
  server_name relay.example.com;

  ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3199;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;
  }
}
```

Then configure the local connector:

```bash
PORTAL_RELAY_URL=wss://relay.example.com/
PORTAL_CONNECTOR_TOKEN=<same as server PORTAL_CONNECTOR_TOKEN>
```

### Caddy Example

```caddyfile
portal.example.com {
  reverse_proxy 127.0.0.1:3100
}

relay.example.com {
  reverse_proxy 127.0.0.1:3199
}
```

Caddy handles WebSocket upgrade automatically.

## Platform Distribution

On the local invest-agent service, set:

```bash
PORTAL_DISTRIBUTION_URL=http://118.145.115.197:22649/api/internal/distribution/provision
PORTAL_DISTRIBUTION_TOKEN=<same as server PORTAL_DISTRIBUTION_TOKEN>
```

Creating a user assistant from Platform should provision the Portal account and return a temporary password that must be changed on first login.

Do not expose Platform through the user portal. On Volcano Cloud, access Platform through the local SSH tunnel on `127.0.0.1:22648`; keep `118.145.115.197:22649` reserved for the user portal.

## Backups

Back up the SQLite database and WAL files while the service is running:

```bash
mkdir -p /var/backups/invest-agent-portal
sqlite3 /var/lib/invest-agent-portal/portal.db ".backup '/var/backups/invest-agent-portal/portal-$(date +%F-%H%M%S).db'"
```

Recommended minimum:

- Hourly backups for the last 24 hours
- Daily backups for the last 14 days
- Copy backups to a different disk or object storage

Restore:

```bash
pm2 stop invest-agent-portal
cp /var/lib/invest-agent-portal/portal.db /var/lib/invest-agent-portal/portal.db.broken.$(date +%s)
cp /var/backups/invest-agent-portal/<backup>.db /var/lib/invest-agent-portal/portal.db
chown -R <app-user>:<app-user> /var/lib/invest-agent-portal
pm2 start invest-agent-portal
```

## Prelaunch Checks

Run before opening access to users:

```bash
npm run typecheck
npm test
npm run build
PORTAL_BASE=http://118.145.115.197:22649 PORTAL_USER=primary PORTAL_PASS='<password>' npx tsx scripts/smoke.ts
```

Expected:

- Bad login returns `INVALID_CREDENTIALS`
- Good login succeeds
- Assistant status is online
- Conversation history loads
- A smoke message sends successfully
- The smoke conversation is readable from Portal history

Also verify on the local invest-agent side:

```bash
curl http://118.145.115.197:22649/api/auth/me
# should return 401 without a cookie
```

## Rollback

If a deployment fails:

```bash
pm2 stop invest-agent-portal
git checkout <previous-good-commit>
npm ci
npm run build
pm2 start invest-agent-portal --update-env
```

If database corruption or bad migration is suspected, restore from backup before restarting.
