import "node:process";
import { createServer } from "node:http";
import { parse } from "node:url";

import next from "next";

import { getConfig } from "./src/lib/config";
import { portalTimeoutSummary } from "./src/lib/config";
import { startRelayServer } from "./src/lib/relay/server";

async function main() {
  const cfg = getConfig();
  const timeoutSummary = portalTimeoutSummary(cfg);
  console.log(
    `[server] timeout config executionBudgetMs=${timeoutSummary.executionBudgetMs} connectorRequestTimeoutMs=${timeoutSummary.connectorRequestTimeoutMs} relayBufferMs=${timeoutSummary.relayBufferMs}`
  );
  const dev = process.env.NODE_ENV !== "production";
  const app = next({ dev, hostname: "0.0.0.0", port: cfg.port });
  const handle = app.getRequestHandler();

  await app.prepare();

  // 在同一进程内启动 WebSocket Relay
  startRelayServer({
    onConnectorChange(event) {
      console.log(`[server] connector ${event.assistantId} online=${event.online}`);
    }
  });

  const server = createServer((req, res) => {
    const url = parse(req.url ?? "/", true);
    void handle(req, res, url);
  });

  server.listen(cfg.port, "0.0.0.0", () => {
    console.log(`[server] Next.js ready on http://0.0.0.0:${cfg.port}`);
    console.log(`[server] Relay listening on the same process`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n[server] received ${signal}, shutting down`);
    server.close();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
