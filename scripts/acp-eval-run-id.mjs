import { randomUUID } from "node:crypto";

export function createAcpEvalRunId(input = {}) {
  const timestamp = input.timestamp ?? Date.now();
  const processId = input.processId ?? process.pid;
  const nonce = input.nonce ?? randomUUID().slice(0, 8);
  return `acp-quality-${timestamp.toString(36)}-${processId.toString(36)}-${nonce}`;
}
