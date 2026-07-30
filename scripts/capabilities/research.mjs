#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const fixtures = { "news-search": "research-news-search.success.json", "web-search": "research-web-search.success.json", "web-read": "research-web-read.success.json" };
const [operation, ...args] = process.argv.slice(2).filter((value) => value !== "--live");
const live = process.argv.includes("--live");
const inputIndex = args.indexOf("--input");
try {
  const input = inputIndex >= 0 ? JSON.parse(args[inputIndex + 1] || "{}") : {};
  if (!fixtures[operation]) throw new Error(`supported operations: ${Object.keys(fixtures).join(", ")}`);
  let result;
  if (!live) {
    result = JSON.parse(await readFile(resolve(process.cwd(), "tests/capabilities/fixtures", fixtures[operation]), "utf8"));
  } else {
    const research = await import("../../dist/services/external-evidence-search.js");
    result = operation === "news-search" ? await research.researchReadCapability.newsSearch(input)
      : operation === "web-search" ? await research.researchReadCapability.webSearch(input)
        : await research.researchReadCapability.webRead(input);
  }
  process.stdout.write(`${JSON.stringify({ operation, mode: live ? "live" : "fixture", result })}\n`);
} catch (error) {
  process.stderr.write(`research capability runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
