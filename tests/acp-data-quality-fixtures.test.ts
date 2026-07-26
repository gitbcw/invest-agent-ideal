import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "acp-data-quality", "core-v1.json");

test("ACP data-quality core fixture has a stable, reviewable contract", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    suite?: unknown;
    version?: unknown;
    cases?: Array<Record<string, unknown>>;
  };
  assert.equal(fixture.suite, "acp-data-quality-core");
  assert.equal(fixture.version, "v2");
  assert.ok(Array.isArray(fixture.cases));
  assert.ok(fixture.cases.length >= 10);

  const ids = new Set<string>();
  for (const entry of fixture.cases) {
    assert.equal(typeof entry.id, "string");
    assert.match(entry.id as string, /^[a-z0-9-]+$/);
    assert.equal(ids.has(entry.id as string), false, `duplicate case id: ${entry.id}`);
    ids.add(entry.id as string);
    assert.equal(typeof entry.prompt, "string");
    assert.ok((entry.prompt as string).includes("不要写入任何配置"));
    assert.ok(Array.isArray(entry.allowedTools) && entry.allowedTools.length > 0);
    assert.ok(Array.isArray(entry.expectedOperations) && entry.expectedOperations.length > 0);
    assert.equal(typeof entry.maxToolCalls, "number");
    assert.ok((entry.maxToolCalls as number) >= entry.expectedOperations.length);
    assert.ok(entry.expectedOperationMode === undefined || entry.expectedOperationMode === "all" || entry.expectedOperationMode === "any");
    assert.ok(entry.turns === undefined || (Array.isArray(entry.turns) && entry.turns.length >= 2 && entry.turns.every((turn) => typeof turn === "string")));
    assert.ok(entry.expectedOperationsPerTurn === undefined || (Array.isArray(entry.expectedOperationsPerTurn)
      && Array.isArray(entry.turns)
      && entry.expectedOperationsPerTurn.length === entry.turns.length
      && entry.expectedOperationsPerTurn.every((operations) => Array.isArray(operations) && operations.length > 0)));
    assert.ok(entry.urlEvidenceOperations === undefined || (Array.isArray(entry.urlEvidenceOperations) && entry.urlEvidenceOperations.length > 0));
    assert.ok(entry.maxOperationCounts === undefined || (typeof entry.maxOperationCounts === "object"
      && entry.maxOperationCounts !== null
      && Object.values(entry.maxOperationCounts).every((count) => typeof count === "number" && count > 0)));
    assert.ok(Array.isArray(entry.goldFacts) && entry.goldFacts.length > 0);
    for (const fact of entry.goldFacts as Array<Record<string, unknown>>) {
      if (fact.comparisonTolerance !== undefined) {
        assert.equal(typeof fact.expected, "number");
        assert.equal(typeof fact.comparisonTolerance, "number");
        assert.ok((fact.comparisonTolerance as number) > 0);
        assert.equal(typeof fact.unit, "string");
        assert.equal(typeof fact.adjustment, "string");
      }
    }
    assert.ok(Array.isArray(entry.requiredEvidence) && entry.requiredEvidence.length > 0);
    assert.ok(Array.isArray(entry.forbiddenClaims) && entry.forbiddenClaims.length > 0);
  }

  for (const caseId of ["industry-web-evidence", "web-source-conflict-disclosure"]) {
    const entry = fixture.cases.find((candidate) => candidate.id === caseId);
    assert.ok(entry, `missing case: ${caseId}`);
    assert.doesNotMatch(entry.prompt as string, /必须(?:读取|使用|采用)[^。]*(?:官方|原文)|只采用[^。]*原文/);
    const namesFact = (entry.goldFacts as Array<Record<string, unknown>>)
      .find((fact) => fact.field === "industryNames");
    assert.ok(namesFact && Array.isArray(namesFact.expected));
    assert.equal(namesFact.expected.length, 31);
    assert.equal(new Set(namesFact.expected).size, 31);
  }
});
