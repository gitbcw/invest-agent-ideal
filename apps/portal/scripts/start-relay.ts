import "node:process";

import { startRelayServer } from "../src/lib/relay/server";

const server = startRelayServer();

const shutdown = (signal: string) => {
  console.log(`\n[start-relay] received ${signal}`);
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("[start-relay] running, press Ctrl+C to exit");
