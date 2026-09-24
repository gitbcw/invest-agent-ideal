import assert from "node:assert/strict";
import test from "node:test";

import {
  methodCreateSchema,
  methodAddVersionSchema,
  methodAdoptSchema,
  methodWorkingCopySaveSchema,
  skillCreateSchema,
  skillEditSchema,
  skillEnableSchema,
  skillInstallSchema,
} from "../src/lib/workspace-schemas";
import { PORTAL_TYPES } from "../src/lib/protocol/envelope";
import { statusForCode } from "../src/lib/protocol/error-status";
import { selectDiffVersion } from "../src/components/workspace/MethodsPanel";

test("workspace protocol exposes every method/skill connector command", () => {
  assert.deepEqual(
    [
      PORTAL_TYPES.METHOD_LIST,
      PORTAL_TYPES.METHOD_GET,
      PORTAL_TYPES.METHOD_VERSIONS,
      PORTAL_TYPES.METHOD_DIFF,
      PORTAL_TYPES.METHOD_CREATE,
      PORTAL_TYPES.METHOD_ADD_VERSION,
      PORTAL_TYPES.METHOD_ADOPT,
      PORTAL_TYPES.METHOD_REVOKE,
      PORTAL_TYPES.METHOD_ASSET_LIST,
      PORTAL_TYPES.METHOD_WORKING_COPY_GET,
      PORTAL_TYPES.METHOD_WORKING_COPY_SAVE,
      PORTAL_TYPES.METHOD_WORKING_COPY_CLEAR,
      PORTAL_TYPES.SKILL_LIST_PRIVATE,
      PORTAL_TYPES.SKILL_LIST_INSTALLED,
      PORTAL_TYPES.SKILL_LIST_PROJECT_FILES,
      PORTAL_TYPES.SKILL_GET,
      PORTAL_TYPES.SKILL_CREATE,
      PORTAL_TYPES.SKILL_EDIT,
      PORTAL_TYPES.SKILL_COMPARE_VERSIONS,
      PORTAL_TYPES.SKILL_SET_ENABLED,
      PORTAL_TYPES.SKILL_INSTALL,
      PORTAL_TYPES.SKILL_UNINSTALL,
      PORTAL_TYPES.SKILL_UPGRADE,
      PORTAL_TYPES.ASSET_WORKSPACE_USAGE,
    ],
    [
      "method.list",
      "method.get",
      "method.versions",
      "method.diff",
      "method.create",
      "method.add_version",
      "method.adopt",
      "method.revoke",
      "method.asset.list",
      "method.working_copy.get",
      "method.working_copy.save",
      "method.working_copy.clear",
      "skill.list_private",
      "skill.list_installed",
      "skill.list_project_files",
      "skill.get",
      "skill.create",
      "skill.edit",
      "skill.compare_versions",
      "skill.set_enabled",
      "skill.install",
      "skill.uninstall",
      "skill.upgrade",
      "asset.workspace_usage",
    ],
  );
});

test("workspace HTTP request schemas reject browser scope fields", () => {
  const scopeFields = { userId: "111", instanceId: "invest-agent-111", projectId: "invest-agent" };
  const validMethod = { name: "锂板块四因子", text: "# 正文" };
  const validSkill = { slug: "lithium-review", name: "锂复盘", text: "# SKILL" };

  for (const [schema, valid] of [
    [methodCreateSchema, validMethod],
    [skillCreateSchema, validSkill],
  ] as const) {
    const withScope = { ...valid, ...scopeFields };
    assert.equal(schema.safeParse(withScope).success, false, "scope fields must be rejected by strict schema");
    assert.equal(schema.safeParse(valid).success, true);
  }

  assert.equal(methodAddVersionSchema.safeParse({ text: "# v2", ...scopeFields }).success, false);
  assert.equal(methodAdoptSchema.safeParse({ versionId: "version_x", ...scopeFields }).success, false);
  assert.equal(methodWorkingCopySaveSchema.safeParse({ draftText: "# 草稿", ...scopeFields }).success, false);
  assert.equal(skillEditSchema.safeParse({ text: "# v2", ...scopeFields }).success, false);
  assert.equal(skillEnableSchema.safeParse({ versionId: "version_x", enabled: true, ...scopeFields }).success, false);
  assert.equal(skillInstallSchema.safeParse({ releaseId: "release_x", ...scopeFields }).success, false);
});

test("working copy schema accepts draft text with optional base version, rejects empty drafts", () => {
  assert.equal(methodWorkingCopySaveSchema.safeParse({ draftText: "# 未发布修改" }).success, true);
  assert.equal(methodWorkingCopySaveSchema.safeParse({ draftText: "# 未发布修改", baseVersionId: "version_x" }).success, true);
  assert.equal(methodWorkingCopySaveSchema.safeParse({ draftText: "" }).success, false, "空工作副本没有意义，清除走 DELETE");
  assert.equal(methodWorkingCopySaveSchema.safeParse({}).success, false);
});

test("skill enable schema only accepts enabled=true (first version disables via uninstall)", () => {
  assert.equal(skillEnableSchema.safeParse({ versionId: "v", enabled: true }).success, true);
  assert.equal(skillEnableSchema.safeParse({ versionId: "v", enabled: false }).success, false);
});

test("agent-space connector error codes map to stable HTTP statuses", () => {
  assert.equal(statusForCode("AGENT_SPACE_SCOPE_MISMATCH"), 403);
  assert.equal(statusForCode("AGENT_SPACE_NOT_FOUND"), 404);
  assert.equal(statusForCode("AGENT_SPACE_APPROVAL_REQUIRED"), 403);
  assert.equal(statusForCode("AGENT_SPACE_ARGUMENT_INVALID"), 400);
  assert.equal(statusForCode("AGENT_SPACE_INVALID_TRANSITION"), 409);
  assert.equal(statusForCode("AGENT_SPACE_ADOPTION_CONSTRAINT"), 409);
});

test("method diff selection waits for two distinct versions before requesting", () => {
  assert.deepEqual(selectDiffVersion(null, "v1"), { from: "v1", to: "" });
  assert.deepEqual(selectDiffVersion({ from: "v1", to: "" }, "v2"), { from: "v1", to: "v2" });
  assert.deepEqual(selectDiffVersion({ from: "v1", to: "" }, "v1"), { from: "v1", to: "" });
  assert.deepEqual(selectDiffVersion({ from: "v1", to: "v2" }, "v3"), { from: "v3", to: "" });
});
