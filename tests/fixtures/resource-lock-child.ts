import { withResourceMutationLock } from "../../src/services/resource-mutation-lock.js";

async function main() {
  const lockRoot = process.env.TEST_RESOURCE_LOCK_ROOT;
  if (!lockRoot) throw new Error("TEST_RESOURCE_LOCK_ROOT is required");

  await withResourceMutationLock(
    { userId: "user-a", instanceId: "child-instance" },
    "portfolio",
    async () => {
      process.stdout.write("locked\n");
      await new Promise<void>((resolve) => process.stdin.once("data", () => {
        // Pause stdin so the still-open pipe does not keep the event loop alive.
        process.stdin.pause();
        resolve();
      }));
    },
    { lockRoot },
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
