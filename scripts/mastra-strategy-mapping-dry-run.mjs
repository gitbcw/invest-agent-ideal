#!/usr/bin/env node

/**
 * Read one backed-up strategy.yaml and produce a multi-owner mapping. No
 * database or project file is written; the source snapshot is always read-only.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const workspaceId = requiredId(args.workspaceId, "--workspace-id");
const userId = requiredId(args.userId, "--user-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
const outputPath = requiredAbsolute(args.out, "--out");
const strategyPath = path.join(snapshotRoot, workspaceId, "config", "strategy.yaml");

await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertOutputOutsideSnapshot(outputPath, snapshotRoot);
const raw = await readFile(strategyPath, "utf8");
const strategy = parse(raw);
if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) throw new Error("strategy.yaml must contain a mapping");
const mapping = mapStrategy(strategy);
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "dry_run",
  source: {
    workspaceId,
    sourcePath: "config/strategy.yaml",
    sha256: sha256(raw),
    userId,
    instanceId,
  },
  mapping,
  validation: {
    unmappedTopLevelFields: mapping.unknownTopLevelFields,
    sourceWriteAttempted: false,
    targetWriteAttempted: false,
    conflict: false,
  },
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, outputPath, source: report.source, validation: report.validation }, null, 2));

function mapStrategy(strategy) {
  const profile = asRecord(strategy.profile, "profile");
  const serviceProfile = {
    style: stringOrNull(profile.style),
    selectedStylePack: stringOrNull(profile.selected_style_pack),
    riskPreference: stringOrNull(profile.risk_preference),
    investmentHorizon: stringOrNull(profile.investment_horizon),
    markets: arrayOrDefault(profile.markets),
    userMode: stringOrNull(profile.user_mode),
    investorSegment: stringOrNull(profile.investor_segment),
    decisionCadence: stringOrNull(profile.decision_cadence),
    preferredAssets: arrayOrDefault(profile.preferred_assets),
    allocation: objectOrDefault(strategy.allocation),
    positionRoles: objectOrDefault(strategy.position_roles),
    sourceRevision: stringOrNull(strategy.last_confirmed_at),
  };
  const projectMethod = {
    buyRules: arrayOrDefault(strategy.buy_rules),
    sellRules: arrayOrDefault(strategy.sell_rules),
    rebalanceRules: arrayOrDefault(strategy.rebalance_rules),
    riskRules: arrayOrDefault(strategy.risk_rules),
    doNotDoRules: arrayOrDefault(strategy.do_not_do_rules),
    decisionBoundaries: objectOrDefault(strategy.decision_boundaries),
    notes: stringOrNull(strategy.notes),
    sourceRevision: stringOrNull(strategy.last_confirmed_at),
  };
  const known = new Set([
    "profile", "allocation", "position_roles", "buy_rules", "sell_rules", "rebalance_rules", "risk_rules",
    "do_not_do_rules", "decision_boundaries", "notes", "last_confirmed_at", "last_confirmed_by",
    "last_confirmation_id", "last_method_change_candidate_id",
  ]);
  return {
    serviceMigration: {
      target: "investment_profile service-owned record",
      fields: serviceProfile,
      idempotencyKey: `strategy-profile:${sha256(JSON.stringify(serviceProfile))}`,
      writePolicy: "later import only; compare a same-scope target revision before upsert",
    },
    projectFile: {
      target: "methods/strategy-rules.md plus immutable source asset",
      fields: projectMethod,
      idempotencyKey: `strategy-method:${sha256(JSON.stringify(projectMethod))}`,
      writePolicy: "later import preserves source YAML as an asset; no code execution or permission expansion",
    },
    sourceMetadata: {
      lastConfirmedBy: stringOrNull(strategy.last_confirmed_by),
      lastConfirmationId: stringOrNull(strategy.last_confirmation_id),
      lastMethodChangeCandidateId: stringOrNull(strategy.last_method_change_candidate_id),
    },
    unknownTopLevelFields: Object.keys(strategy).filter((key) => !known.has(key)).sort(),
  };
}

function asRecord(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`strategy.${label} must be an object`);
  return value;
}
function objectOrDefault(value) { return value === undefined || value === null ? {} : asRecord(value, "object field"); }
function arrayOrDefault(value) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new Error("strategy array field must be an array"); return value; }
function stringOrNull(value) { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string") throw new Error("strategy string field must be a string"); return value; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertOutputOutsideSnapshot(output, snapshotRoot) {
  const root = await realpath(snapshotRoot);
  const candidate = path.join(await realpath(path.dirname(output)), path.basename(output));
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("--out must be outside the workspace snapshot source");
}
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--workspace-snapshot", "--workspace-id", "--user-id", "--instance-id", "--out"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index];
  }
  return values;
}
