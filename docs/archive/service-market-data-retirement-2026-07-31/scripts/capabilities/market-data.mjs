#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const fixtureByOperation = {
  quote: "market-quote.success.json",
  kline: "market-kline.success.json",
  indices: "market-indices.success.json",
  calendar: "market-calendar.success.json",
  health: "market-health.success.json",
};

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === "live") {
      flags.set(key, true);
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) fail(`missing value for --${key}`);
    flags.set(key, next);
    index += 1;
  }
  return { operation: positional[0], flags };
}

function parseInput(flags) {
  const raw = flags.get("input");
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") fail("--input must be a JSON object");
    return value;
  } catch (error) {
    fail(`invalid --input JSON: ${error.message}`);
  }
}

async function fixtureResult(operation, fixtureOverride) {
  const fixtureName = fixtureOverride || fixtureByOperation[operation];
  if (!fixtureName) fail(`unsupported operation: ${operation || "(missing)"}`);
  const fixturePath = resolve(process.cwd(), "tests/capabilities/fixtures", fixtureName);
  try {
    return JSON.parse(await readFile(fixturePath, "utf8"));
  } catch (error) {
    fail(`unable to load fixture ${fixtureName}: ${error.message}`);
  }
}

async function liveResult(operation, input) {
  const market = await import("../../dist/services/market-data.js");
  switch (operation) {
    case "quote": return market.marketQuote(input.codes || []);
    case "kline": return market.marketKline(input);
    case "indices": return market.marketIndices();
    case "calendar": return market.marketCalendar(input.date ? new Date(input.date) : new Date());
    case "health": return market.marketHealth();
    default: return fail(`unsupported operation: ${operation || "(missing)"}`);
  }
}

try {
  const { operation, flags } = parseArgs(process.argv.slice(2));
  if (!fixtureByOperation[operation]) fail(`supported operations: ${Object.keys(fixtureByOperation).join(", ")}`);
  const input = parseInput(flags);
  const live = flags.get("live") === true;
  const result = live
    ? await liveResult(operation, input)
    : await fixtureResult(operation, flags.get("fixture"));
  process.stdout.write(`${JSON.stringify({ operation, mode: live ? "live" : "fixture", result })}\n`);
} catch (error) {
  process.stderr.write(`market-data capability runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
