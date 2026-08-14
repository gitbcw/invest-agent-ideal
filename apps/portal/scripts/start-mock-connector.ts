import "node:process";

import { createMockConnectorFromEnv } from "../src/lib/mock/connector";

async function main() {
  const connector = createMockConnectorFromEnv();
  connector.start();
  console.log("[start-mock-connector] ready, press Ctrl+C to exit");

  const shutdown = async (signal: string) => {
    console.log(`\n[start-mock-connector] received ${signal}, shutting down`);
    await connector.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error("[start-mock-connector] fatal:", err);
  process.exit(1);
});
