import assert from "node:assert/strict";
import test from "node:test";
import { isMineruAvailable } from "../src/services/mineru-parse.js";

// file.parse 工具 (T-235) 的离线单元测试。
// 真实 MinerU REST API 链路 (上传→轮询→下载 markdown) 已在调研阶段手动验证通过,
// 这里覆盖可用性判断的契约 (token 缺失时工具必须拒绝,避免误导 AI)。

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("isMineruAvailable returns false when MINERU_API_TOKEN is absent", () => {
  const prev = process.env.MINERU_API_TOKEN;
  delete process.env.MINERU_API_TOKEN;
  try {
    assert.equal(isMineruAvailable(), false);
  } finally {
    restoreEnv("MINERU_API_TOKEN", prev);
  }
});

test("isMineruAvailable returns false when MINERU_API_TOKEN is empty/whitespace", () => {
  const prev = process.env.MINERU_API_TOKEN;
  for (const empty of ["", "   ", "\t"]) {
    process.env.MINERU_API_TOKEN = empty;
    assert.equal(isMineruAvailable(), false, `expected false for token=${JSON.stringify(empty)}`);
  }
  restoreEnv("MINERU_API_TOKEN", prev);
});

test("isMineruAvailable returns true when MINERU_API_TOKEN is set", () => {
  const prev = process.env.MINERU_API_TOKEN;
  process.env.MINERU_API_TOKEN = "sk-test-token-xxx";
  try {
    assert.equal(isMineruAvailable(), true);
  } finally {
    restoreEnv("MINERU_API_TOKEN", prev);
  }
});
