import assert from "node:assert/strict";
import test from "node:test";

import { PORTAL_TYPES } from "../src/lib/protocol/envelope";
import { skillStatusSchema } from "../src/lib/workspace-schemas";

test("skill installation protocol exposes catalog and status commands", () => {
  assert.equal(PORTAL_TYPES.SKILL_LIST_CATALOG, "skill.list_catalog");
  assert.equal(PORTAL_TYPES.SKILL_INSTALLATION_STATUS, "skill.installation_status");
});

test("skill installation status schema accepts only an enabled boolean", () => {
  assert.equal(skillStatusSchema.safeParse({ enabled: true }).success, true);
  assert.equal(skillStatusSchema.safeParse({ enabled: false }).success, true);
  assert.equal(skillStatusSchema.safeParse({ enabled: "true" }).success, false);
  assert.equal(skillStatusSchema.safeParse({ enabled: true, userId: "111" }).success, false);
});
