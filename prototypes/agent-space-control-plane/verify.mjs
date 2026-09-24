import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const fixture = JSON.parse(await readFile(new URL("./fixture.json", import.meta.url), "utf8"));
assert.equal(fixture.metadata.productionConnected, false, "prototype fixture must never declare a production connection");
assert.equal(fixture.metadata.dataMode, "sanitized-replay");
assert.equal(fixture.metadata.scope, "scope-demo");
assert.ok(fixture.runs.every((run) => run.basis.injection.workspace === null), "run basis must prove no Workspace injection");
assert.ok(fixture.runs.every((run) => run.basis.state.note === "not-integrated-until-W5"), "state integration must remain explicit");
assert.ok(fixture.tasks.some((task) => task.dependencies.length === 0 && task.emptyReason), "explicit empty dependency state must be visible");
assert.ok(fixture.methods.some((method) => method.status === "owner-review"));
console.log("T-536 fixture boundary checks passed");
