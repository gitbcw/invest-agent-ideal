import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  listWeixinAccountIds,
  replaceWeixinAccount,
  resolveWeixinStateDir,
  saveWeixinAccount,
} from "../src/channels/weixin-account-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("weixin account store", () => {
  test("keeps only the newest account after a confirmed re-scan", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "invest-agent-weixin-account-"));
    tempDirs.push(stateDir);
    saveWeixinAccount("old-bot", { token: "old-token" }, stateDir);
    saveWeixinAccount("another-old-bot", { token: "another-old-token" }, stateDir);
    const accountsDir = join(resolveWeixinStateDir(stateDir), "accounts");
    writeFileSync(join(accountsDir, "old.bot.json.sync.json"), "{}");

    const replaced = replaceWeixinAccount("new-bot", { token: "new-token" }, stateDir);

    assert.deepEqual(replaced.sort(), ["another-old-bot", "old-bot"]);
    assert.deepEqual(listWeixinAccountIds(stateDir), ["new-bot"]);
    assert.equal(existsSync(join(accountsDir, "old-bot.json")), false);
    assert.equal(existsSync(join(accountsDir, "old.bot.json.sync.json")), false);
    assert.equal(existsSync(join(accountsDir, "another-old-bot.json")), false);
    assert.equal(existsSync(join(accountsDir, "new-bot.json")), true);
  });
});
