#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const fixture = resolve(process.cwd(), "tests/capabilities/fixtures/indicators.deterministic.json");
const result = JSON.parse(await readFile(fixture, "utf8"));
process.stdout.write(`${JSON.stringify({ operation: "l1", mode: "fixture", result })}\n`);
