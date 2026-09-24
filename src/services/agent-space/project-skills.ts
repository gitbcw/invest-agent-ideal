import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { mastraWorkspaceRegistry } from "../../mastra/workspace-registry.js";
import { assertScopeValid, type UserScope } from "./core.js";

const SKILL_SLUG = /^[a-z0-9][a-z0-9-_.]{1,120}$/;
const MAX_SKILL_BYTES = 128 * 1024;

export interface ProjectSkillPreview {
  slug: string;
  name: string;
  description: string;
  text: string;
}

/** Project files are historical candidates, never installed runtime skills. */
export async function listProjectSkillPreviews(scope: UserScope): Promise<ProjectSkillPreview[]> {
  assertScopeValid(scope);
  const project = await mastraWorkspaceRegistry.resolve(scope);
  if (!project) return [];
  const skillsRoot = path.join(project.realProjectRoot, "skills");
  const rootStat = await lstat(skillsRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return [];
  const directories = await readdir(skillsRoot, { withFileTypes: true });
  const previews: ProjectSkillPreview[] = [];
  for (const entry of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!SKILL_SLUG.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const dirStat = await lstat(skillDir).catch(() => null);
    if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) continue;
    const file = path.join(skillDir, "SKILL.md");
    const stat = await lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) continue;
    const resolved = await realpath(file).catch(() => null);
    if (resolved !== file) continue;
    const text = await readFile(file, "utf8");
    let name = entry.name;
    let description = "";
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (frontmatter) {
      const doc = YAML.parseDocument(frontmatter[1], { uniqueKeys: true });
      if (!doc.errors.length) {
        const meta = doc.toJS();
        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
          if (typeof meta.name === "string") name = meta.name.slice(0, 200);
          if (typeof meta.description === "string") description = meta.description.slice(0, 2000);
        }
      }
    }
    previews.push({ slug: entry.name, name, description, text });
  }
  return previews;
}
