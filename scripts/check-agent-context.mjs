#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const markdownFiles = ["AGENTS.md", "CLAUDE.md", ...walk("docs"), ...walk(".codex/skills")]
  .filter((file) => file.endsWith(".md") && !file.startsWith("docs/archive/") && !file.includes("/.system/"));
const contractFiles = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "docs/README.md",
  "docs/system-overview.md",
  "docs/service-tools-mcp.md",
  "docs/quality/test-system-health-review.md",
  ...markdownFiles.filter((file) => file.startsWith(".codex/skills/")),
]);
const errors = [];

for (const file of markdownFiles) {
  const content = readFileSync(path.join(root, file), "utf8");
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    const reference = decodeURIComponent(match[1]);
    if (/^(https?:|mailto:)/.test(reference)) continue;
    checkPath(file, reference, lineAt(content, match.index), "markdown link");
  }
  if (contractFiles.has(file)) {
    for (const match of content.matchAll(/`((?:docs|src|scripts|tests|templates|\.codex)\/[^`\s]+)`/g)) {
      const reference = match[1].replace(/[.,:;]$/, "").replace(/:\d+(?::\d+)?$/, "");
      if (/[<>{}*]/.test(reference) || reference.endsWith("/")) continue;
      checkPath(file, reference, lineAt(content, match.index), "repository path", true);
    }
    for (const match of content.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      if (!packageJson.scripts[match[1]]) {
        errors.push(`${file}:${lineAt(content, match.index)}: unknown npm script ${match[1]}`);
      }
    }
  }
}

checkMcpInventory();

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`agent context ok: ${markdownFiles.length} markdown files, ${Object.keys(packageJson.scripts).length} npm scripts`);

function walk(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relativeDir, entry.name);
    if (entry.name === "archive" || entry.name === ".system") return [];
    return entry.isDirectory() ? walk(child) : [child];
  });
}

function checkPath(sourceFile, reference, line, label, fromRoot = false) {
  const clean = reference.split("#")[0];
  const resolved = fromRoot ? path.join(root, clean) : path.resolve(root, path.dirname(sourceFile), clean);
  if (!existsSync(resolved)) errors.push(`${sourceFile}:${line}: missing ${label} ${reference}`);
}

function lineAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function checkMcpInventory() {
  const source = readFileSync(path.join(root, "src/mcp/invest-agent-service-tools.ts"), "utf8");
  const implementation = new Set(
    [...source.matchAll(/registerJsonTool\(\s*\{[\s\S]*?\}\s*,\s*"([^"]+)"/g)].map((match) => match[1])
  );
  const docs = readFileSync(path.join(root, "docs/service-tools-mcp.md"), "utf8");
  const section = docs.match(/## Current Tools([\s\S]*?)## Verification/)?.[1] ?? "";
  const documented = new Set([...section.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]));
  for (const name of implementation) {
    if (!documented.has(name)) errors.push(`docs/service-tools-mcp.md: missing MCP tool ${name}`);
  }
  for (const name of documented) {
    if (!implementation.has(name)) errors.push(`docs/service-tools-mcp.md: stale MCP tool ${name}`);
  }
}
