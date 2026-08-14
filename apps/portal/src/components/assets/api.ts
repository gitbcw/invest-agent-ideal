import type { UserAsset, UserAssetFolder, UserAssetListResult, UserAssetReferencesResult, UserAssetUploadBatchResult, UserAssetVersion, UserAssetVersionPayload, UserAssetVersionsResult } from "@/lib/protocol";

type Envelope<T> = { ok: true; data: T } | { ok: false; error?: { code?: string; message?: string } };

export class AssetRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { credentials: "same-origin", ...init }); } catch { throw new Error("文件服务暂时不可用"); }
  const body = await response.json() as Envelope<T>;
  if (!body.ok) throw new AssetRequestError(body.error?.message || "文件请求失败", body.error?.code);
  return body.data;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function listAssets(query: { status?: string; search?: string; format?: string; source?: string; folderId?: string | null; limit?: number } = {}): Promise<UserAssetListResult> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.search) params.set("search", query.search);
  if (query.format) params.set("format", query.format);
  if (query.source) params.set("source", query.source);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.folderId !== undefined) params.set("folderId", query.folderId || "");
  return await request<UserAssetListResult>(`/api/assets?${params}`);
}
export async function listFolders(): Promise<UserAssetFolder[]> { return (await request<{ items: UserAssetFolder[] }>("/api/assets/folders")).items; }
export function createFolder(name: string, parentFolderId?: string | null): Promise<UserAssetFolder> { return request<UserAssetFolder>("/api/assets/folders", { ...json({ name, parentFolderId }), method: "POST" }); }
export function renameFolder(folderId: string, name: string): Promise<UserAssetFolder> { return request<UserAssetFolder>(`/api/assets/folders/${encodeURIComponent(folderId)}`, { ...json({ name }), method: "PATCH" }); }
export function deleteFolder(folderId: string): Promise<{ folderId: string }> { return request<{ folderId: string }>(`/api/assets/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" }); }
export function moveAsset(assetId: string, folderId: string | null): Promise<UserAsset> { return request<UserAsset>(`/api/assets/${encodeURIComponent(assetId)}/folder`, { ...json({ folderId }), method: "PATCH" }); }
export function getAsset(assetId: string): Promise<UserAsset> { return request<UserAsset>(`/api/assets/${encodeURIComponent(assetId)}`); }
export async function listAssetVersions(assetId: string): Promise<UserAssetVersion[]> { return (await request<UserAssetVersionsResult>(`/api/assets/${encodeURIComponent(assetId)}/versions`)).items; }
export function getAssetVersion(assetId: string, versionId: string): Promise<UserAssetVersionPayload> { return request<UserAssetVersionPayload>(`/api/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}`); }
export function listAssetReferences(assetId: string): Promise<UserAssetReferencesResult> { return request<UserAssetReferencesResult>(`/api/assets/${encodeURIComponent(assetId)}/references`); }
export function renameAsset(assetId: string, name: string): Promise<UserAsset> { return request<UserAsset>(`/api/assets/${encodeURIComponent(assetId)}`, { ...json({ name }), method: "PATCH" }); }
export function archiveAsset(assetId: string): Promise<UserAsset> { return request<UserAsset>(`/api/assets/${encodeURIComponent(assetId)}/archive`, json({})); }
export function deleteAsset(assetId: string): Promise<{ assetId: string; deletedVersions: number }> { return request<{ assetId: string; deletedVersions: number }>(`/api/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }); }
export function restoreAssetVersion(assetId: string, versionId: string, expectedVersionId: string): Promise<UserAsset> {
  return request<UserAsset>(`/api/assets/${encodeURIComponent(assetId)}/restore-version`, json({ versionId, expectedVersionId, idempotencyKey: `portal:restore:${assetId}:${versionId}:${expectedVersionId}` }));
}
export function uploadAsset(input: { name?: string; fileName: string; mimeType?: string; folderId?: string | null; base64: string; idempotencyKey: string }): Promise<UserAsset> {
  return request<UserAsset>("/api/assets", json(input));
}
export function uploadAssets(files: Array<{ name?: string; fileName: string; mimeType?: string; folderId?: string | null; base64: string; idempotencyKey: string }>): Promise<UserAssetUploadBatchResult> {
  return request<UserAssetUploadBatchResult>("/api/assets", json({ files }));
}

export function downloadAsset(version: UserAssetVersionPayload): void {
  const raw = atob(version.base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: version.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = version.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function assetDataUrl(version: UserAssetVersionPayload): string {
  return `data:${version.mimeType};base64,${version.base64}`;
}

export function fileToAsset(file: File): Promise<{ fileName: string; mimeType?: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve({ fileName: file.name, mimeType: file.type || undefined, base64: comma >= 0 ? result.slice(comma + 1) : result });
    };
    reader.readAsDataURL(file);
  });
}

const IMAGE_OPTIMIZATION_THRESHOLD = 1024 * 1024;

/**
 * Generate a conservative browser-side candidate for large JPEG/WebP files.
 * The Runtime remains authoritative and repeats normalization, so an
 * unsupported browser or an unhelpful candidate simply falls back to bytes
 * from the original File.
 */
export async function prepareImageUpload(file: File): Promise<{
  fileName: string;
  mimeType?: string;
  base64: string;
  originalBytes: number;
  candidateBytes: number;
  optimized: boolean;
}> {
  const original = await fileToAsset(file);
  if (file.size <= IMAGE_OPTIMIZATION_THRESHOLD || !/^image\/(jpeg|webp)$/i.test(file.type)) {
    return { ...original, originalBytes: file.size, candidateBytes: file.size, optimized: false };
  }
  const candidate = await createImageCandidate(file);
  if (!candidate || candidate.size >= file.size || candidate.size > 10 * IMAGE_OPTIMIZATION_THRESHOLD) {
    return { ...original, originalBytes: file.size, candidateBytes: file.size, optimized: false };
  }
  const encoded = await fileToAsset(new File([candidate], file.name, { type: file.type }));
  return { ...encoded, originalBytes: file.size, candidateBytes: candidate.size, optimized: true };
}

async function createImageCandidate(file: File): Promise<Blob | null> {
  if (typeof window === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("image decode failed"));
      element.src = objectUrl;
    });
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, 0.88));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
