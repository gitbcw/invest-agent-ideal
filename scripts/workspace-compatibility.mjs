#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  WORKSPACE_MIGRATION_CONFIRMATION,
  discoverWorkspacePaths,
  inspectWorkspaceCompatibility,
  migrateWorkspaceCompatibility,
} from "../dist/lib/workspace-compatibility.js";

const [command = "preflight", ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const workspaceRoot = path.resolve(args["workspace-root"] || process.env.WORKSPACE_ROOT || "./workspaces");
const templatePath = path.resolve(args["template-root"] || process.env.WORKSPACE_TEMPLATE_PATH || "./templates/workspace");
const selectedUser = args.user;
const jsonOutput = args.json === "true";

if (!new Set(["preflight", "apply"]).has(command)) {
  fail(`unknown command: ${command}`);
}

let workspacePaths = await discoverWorkspacePaths(workspaceRoot);
if (selectedUser) {
  workspacePaths = workspacePaths.filter((workspacePath) => path.basename(workspacePath) === selectedUser);
}
if (workspacePaths.length === 0) {
  fail(selectedUser
    ? `workspace not found for user ${selectedUser} under ${workspaceRoot}`
    : `no workspaces found under ${workspaceRoot}`);
}

if (command === "preflight") {
  const reports = [];
  for (const workspacePath of workspacePaths) {
    reports.push(await inspectWorkspaceCompatibility({ workspacePath, templatePath }));
  }
  if (jsonOutput) {
    console.log(JSON.stringify({ workspaceRoot, templatePath, reports }, null, 2));
  } else {
    printPreflight(reports);
  }
  if (reports.some((report) => report.status === "blocked")) process.exitCode = 2;
} else {
  const backupRootValue = args["backup-root"];
  if (!backupRootValue) fail("apply requires --backup-root=/absolute/path");
  if (!path.isAbsolute(backupRootValue)) fail("apply backup root must be absolute");
  if (args.confirm !== WORKSPACE_MIGRATION_CONFIRMATION) {
    fail(`apply requires --confirm=${WORKSPACE_MIGRATION_CONFIRMATION}`);
  }
  const runId = args["run-id"] || timestampId();
  const results = [];
  for (const workspacePath of workspacePaths) {
    results.push(await migrateWorkspaceCompatibility({
      workspacePath,
      templatePath,
      backupRoot: backupRootValue,
      confirmation: args.confirm,
      runId,
    }));
  }
  if (jsonOutput) {
    console.log(JSON.stringify({ workspaceRoot, templatePath, runId, results }, null, 2));
  } else {
    console.log(`Workspace compatibility apply run: ${runId}`);
    for (const result of results) {
      console.log(`${result.workspaceId}: ${result.changed ? `updated ${result.changes.length} managed assets; backup=${result.backupPath}` : "already ready"}`);
    }
  }
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (!value.startsWith("--")) fail(`invalid argument: ${value}`);
    const separator = value.indexOf("=");
    if (separator < 0) parsed[value.slice(2)] = "true";
    else parsed[value.slice(2, separator)] = value.slice(separator + 1);
  }
  return parsed;
}

function printPreflight(reports) {
  for (const report of reports) {
    console.log(`${report.workspaceId}: ${report.status}; managed_changes=${report.managedAssetChanges.length}; blockers=${report.blockers.length}; warnings=${report.warnings.length}`);
    for (const change of report.managedAssetChanges) {
      console.log(`  ${change.action} ${change.relativePath}`);
    }
    for (const blocker of report.blockers) console.log(`  BLOCKED ${blocker}`);
    for (const warning of report.warnings) console.log(`  WARN ${warning}`);
  }
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fail(message) {
  console.error(`workspace compatibility: ${message}`);
  process.exit(2);
}
