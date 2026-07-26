import assert from "node:assert/strict";
import test from "node:test";
import { createAcpEvalRunId } from "../scripts/acp-eval-run-id.mjs";

test("ACP evaluation run IDs remain unique across simultaneous processes", () => {
  const first = createAcpEvalRunId({ timestamp: 1_753_513_200_000, processId: 100, nonce: "aaaaaaaa" });
  const second = createAcpEvalRunId({ timestamp: 1_753_513_200_000, processId: 101, nonce: "bbbbbbbb" });

  assert.notEqual(first, second);
  assert.match(first, /^acp-quality-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
  assert.match(second, /^acp-quality-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
});
