import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabaseAt } from "../src/lib/db";
import { UserRepository } from "../src/lib/db/users";

test("reprovisionAsUser updates portal_users row for an existing username", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-distribution-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const users = new UserRepository(db);

    // First provision creates the account.
    const created = users.create({
      username: "dyk",
      passwordHash: "hash-old",
      role: "user",
      assistantId: "invest-agent-dyk",
      instanceId: "invest-agent-dyk",
      displayName: "dyk"
    });
    assert.equal(users.getByUsername("dyk")?.id, created.id);

    // Re-provisioning the same username must UPDATE portal_users (regression:
    // the route previously issued a raw UPDATE against the runtime-owned
    // `users` table, which has no password_hash column and always failed).
    users.reprovisionAsUser(created.id, {
      passwordHash: "hash-new",
      assistantId: "invest-agent-dyk-2",
      instanceId: "invest-agent-dyk-2",
      displayName: "dyk"
    });

    const updated = users.getByUsername("dyk");
    assert.ok(updated);
    assert.equal(updated.passwordHash, "hash-new");
    assert.equal(updated.role, "user");
    assert.equal(updated.assistantId, "invest-agent-dyk-2");
    assert.equal(updated.instanceId, "invest-agent-dyk-2");
    assert.equal(updated.mustChangePassword, 1);

    // Only one row for the username — no duplicate accounts from re-provision.
    assert.equal(users.list().filter((user) => user.username === "dyk").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
