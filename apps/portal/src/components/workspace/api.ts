import type {
  CatalogSkillCardView,
  InstalledSkillCardView,
  PrivateSkillCardView,
  ProjectSkillPreviewView,
  SkillDetailView,
} from "@/lib/workspace-api";

export class WorkspaceRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { code: string; message: string } } | null;
  if (!payload || payload.ok !== true || payload.data === undefined) {
    const error = payload?.error;
    throw new WorkspaceRequestError(error?.code || "REQUEST_FAILED", error?.message || `请求失败（${response.status}）`);
  }
  return payload.data;
}

export function listPrivateSkills() {
  return request<{ items: PrivateSkillCardView[] }>("/api/skills?view=private");
}

export function listInstalledSkills() {
  return request<{ agent: { agentId: string; name: string; status: string }; items: InstalledSkillCardView[] }>("/api/skills?view=installed");
}

export function listSkillCatalog() {
  return request<{ items: CatalogSkillCardView[] }>("/api/skills?view=catalog");
}

export function listProjectSkillFiles() {
  return request<{ items: ProjectSkillPreviewView[] }>("/api/skills?view=project-files");
}

export function getSkill(skillId: string) {
  return request<SkillDetailView>(`/api/skills/${encodeURIComponent(skillId)}`);
}

export function createSkill(input: { slug: string; name: string; description?: string; text: string }) {
  return request<{ skillId: string; version: { versionId: string; status: string } }>("/api/skills", { method: "POST", body: JSON.stringify(input) });
}

export function editSkill(skillId: string, input: { text: string }) {
  return request<{ skillId: string; version: { version_id: string; version_number: number; status: string } }>(
    `/api/skills/${encodeURIComponent(skillId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function enableSkill(skillId: string, versionId: string) {
  return request<unknown>(`/api/skills/${encodeURIComponent(skillId)}/enable`, { method: "POST", body: JSON.stringify({ versionId, enabled: true }) });
}

export function installSkill(skillId: string, input: { releaseId?: string; versionId?: string } = {}) {
  return request<unknown>(`/api/skills/${encodeURIComponent(skillId)}/install`, { method: "POST", body: JSON.stringify(input) });
}

export function setSkillStatus(skillId: string, enabled: boolean) {
  return request<unknown>(`/api/skills/${encodeURIComponent(skillId)}/status`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export function uninstallSkill(skillId: string) {
  return request<unknown>(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
}
