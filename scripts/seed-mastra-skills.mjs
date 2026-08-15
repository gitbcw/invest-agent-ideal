#!/usr/bin/env node
/**
 * Seed system methodology skills into existing Mastra project roots.
 *
 * Idempotent and non-destructive: only files that do not exist yet are
 * copied, so user-evolved skills are never overwritten. Safe to re-run.
 *
 * Usage:
 *   node scripts/seed-mastra-skills.mjs [--dry-run] [--root <projects-root>]
 *
 * --root defaults to MASTRA_PROJECTS_ROOT or ./data/projects (server layout
 * uses data/projects; local dev may use data/mastra-projects).
 */
import { readdir, readFile, stat, mkdir, copyFile, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootIndex = args.indexOf("--root");
const projectsRootArg = rootIndex !== -1 ? args[rootIndex + 1] : undefined;
const projectsRoot = path.resolve(
  projectsRootArg || process.env.MASTRA_PROJECTS_ROOT || path.join(process.cwd(), "data", "projects"),
);
const templateRoot = path.resolve(
  process.env.SYSTEM_SKILLS_TEMPLATE_ROOT || path.join(process.cwd(), "templates", "skills"),
);

const manifestName = ".agent-project/manifest.json";

async function isMastraProject(dir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, manifestName), "utf8"));
    return manifest.schemaVersion === 1 && typeof manifest.userId === "string";
  } catch {
    return false;
  }
}

async function seedProject(projectRoot) {
  const seeded = [];
  const templateEntries = await readdir(templateRoot).catch(() => []);
  for (const entry of templateEntries) {
    const sourceSkillDir = path.join(templateRoot, entry);
    if (!(await stat(sourceSkillDir).catch(() => null))?.isDirectory()) continue;
    const targetSkillDir = path.join(projectRoot, "skills", entry);
    if (!dryRun) await mkdir(targetSkillDir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(sourceSkillDir)) {
      const sourceFile = path.join(sourceSkillDir, file);
      if (!(await stat(sourceFile).catch(() => null))?.isFile()) continue;
      const targetFile = path.join(targetSkillDir, file);
      if (await lstat(targetFile).then(() => true, () => false)) continue;
      if (!dryRun) await copyFile(sourceFile, targetFile);
      seeded.push(`skills/${entry}/${file}`);
    }
  }
  return seeded;
}

const entries = await readdir(projectsRoot).catch(() => null);
if (!entries) {
  console.error(`projects root not found: ${projectsRoot}`);
  process.exit(1);
}
let total = 0;
for (const entry of entries.sort()) {
  const projectRoot = path.join(projectsRoot, entry);
  if (!(await stat(projectRoot).catch(() => null))?.isDirectory()) continue;
  if (!(await isMastraProject(projectRoot))) {
    console.log(`skip (no manifest): ${entry}`);
    continue;
  }
  const seeded = await seedProject(projectRoot);
  total += seeded.length;
  console.log(`${entry}: ${seeded.length === 0 ? "already seeded" : seeded.join(", ")}`);
}
console.log(dryRun ? `[dry-run] would seed ${total} file(s)` : `seeded ${total} file(s)`);
