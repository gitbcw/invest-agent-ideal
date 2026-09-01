import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Portal 协议三处手抄的防漂移护栏（T-451 连带项）：
 *   1. apps/portal/src/lib/protocol/version.ts —— portal 侧版本串
 *   2. apps/portal/src/lib/protocol/envelope.ts —— PORTAL_TYPES 消息类型表
 *   3. src/portal/connector.ts —— connector 侧版本串 + TYPES 表 + capabilities 上报数组
 * 版本串必须逐字相等；消息类型双侧对齐（新增类型漏同步另一侧即红）。
 */

const connectorSource = readFileSync(new URL("../src/portal/connector.ts", import.meta.url), "utf8");

function connectorConstant(name: string): string {
  const match = connectorSource.match(new RegExp(`const ${name} = "([^"]+)"`));
  assert.ok(match, `connector.ts must define ${name}`);
  return match[1];
}

function connectorTypeValues(): Set<string> {
  const typesStart = connectorSource.indexOf("const TYPES = {");
  const typesEnd = connectorSource.indexOf("} as const;", typesStart);
  assert.ok(typesStart > 0 && typesEnd > typesStart, "connector TYPES table not found");
  const values = [...connectorSource.slice(typesStart, typesEnd).matchAll(/:\s*"([a-z_.]+)"/g)].map((m) => m[1]);
  assert.ok(values.length > 30, "connector TYPES table looks truncated");
  return new Set(values);
}

function connectorAdvertisedCapabilities(): string[] {
  const match = connectorSource.match(/capabilities:\s*\[([^\]]+)\]/);
  assert.ok(match, "connector capabilities array not found");
  return [...match[1].matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
}

test("portal and connector agree on protocol version strings", async () => {
  const { PORTAL_PROTOCOL_VERSION, LEGACY_PORTAL_PROTOCOL_VERSION } = await import(
    "../apps/portal/src/lib/protocol/version.js"
  );
  assert.equal(PORTAL_PROTOCOL_VERSION, connectorConstant("PROTOCOL_VERSION"));
  assert.equal(LEGACY_PORTAL_PROTOCOL_VERSION, connectorConstant("LEGACY_PROTOCOL_VERSION"));
});

test("PORTAL_TYPES and connector TYPES stay aligned (new type on one side must reach the other)", async () => {
  const { PORTAL_TYPES } = await import("../apps/portal/src/lib/protocol/envelope.js");
  const portalValues = new Set(Object.values(PORTAL_TYPES as Record<string, string>));
  const connectorValues = connectorTypeValues();

  // Types the portal side keeps for its own envelope handling but the real
  // connector neither advertises nor dispatches.
  const portalOnlyAllowed = new Set([
    "connector.unregister",
    "conversation.sync",
    "dashboard.snapshot",
    "artifact.delete.prepare",
    "artifact.delete.confirm",
  ]);
  for (const value of portalValues) {
    if (portalOnlyAllowed.has(value)) continue;
    assert.ok(connectorValues.has(value), `PORTAL_TYPES.${value} has no connector TYPES entry — sync connector.ts or move it to portalOnlyAllowed with a reason`);
  }

  // Connector-only types the portal envelope table intentionally does not
  // model yet. Extending this set requires a one-line reason.
  const connectorOnlyAllowed = new Set(["automation.migrate_legacy"]);
  for (const value of connectorValues) {
    if (connectorOnlyAllowed.has(value)) continue;
    assert.ok(portalValues.has(value), `connector type ${value} is missing from PORTAL_TYPES — sync envelope.ts or add it to connectorOnlyAllowed with a reason`);
  }
});

test("connector advertises only capabilities it implements", () => {
  const connectorValues = connectorTypeValues();
  const advertised = connectorAdvertisedCapabilities();
  assert.ok(advertised.length > 30, "capabilities array looks truncated");
  // conversation.sync / conversation.attachments are served by dedicated
  // handler paths (detail sync / attachment routing), not the TYPES dispatch.
  const nonDispatchCapabilities = new Set(["conversation.sync", "conversation.attachments"]);
  for (const capability of advertised) {
    if (nonDispatchCapabilities.has(capability)) continue;
    assert.ok(connectorValues.has(capability), `advertised capability ${capability} has no TYPES entry`);
  }
});
