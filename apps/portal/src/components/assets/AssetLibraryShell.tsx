"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Download, File, FileImage, FileText, Folder, FolderInput, FolderOpen, Loader2, MoreHorizontal, Pencil, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import type { ReportAssetMapping, StorageUsage, UserAsset, UserAssetCatalogItem } from "@/lib/protocol";
import { createClientId } from "@/lib/client-id";
import { AssetRequestError, createFolder, deleteAsset, deleteFolder, downloadAsset, getAssetVersion, listAssets, moveAsset, renameFolder, uploadAsset, uploadAssets, prepareImageUpload } from "./api";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { useFilePanel } from "@/components/file-panel/FilePanelProvider";

type SourceFilter = "all" | "upload" | "conversation" | "automation" | "report";
type SourceCounts = Record<SourceFilter, number>;
type Notice = { message: string; folderId?: string };
type FolderRecord = { folderId: string; parentFolderId: string | null; name: string; createdAt?: string; updatedAt?: string };
const ASSET_DRAG_MIME = "application/x-invest-asset";

export function AssetLibraryShell() {
  const searchParams = useSearchParams();
  const requestedAssetId = searchParams.get("assetId");
  const [assets, setAssets] = useState<UserAsset[]>([]);
  const [sourceCounts, setSourceCounts] = useState<SourceCounts>({ all: 0, upload: 0, conversation: 0, automation: 0, report: 0 });
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [catalog, setCatalog] = useState<UserAssetCatalogItem[]>([]);
  const [reportMappings, setReportMappings] = useState<ReportAssetMapping[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const filePanel = useFilePanel();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderDialogParentId, setFolderDialogParentId] = useState<string | null | undefined>(undefined);
  const [renamingFolder, setRenamingFolder] = useState<FolderRecord | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<FolderRecord | null>(null);
  const [movingAsset, setMovingAsset] = useState<UserAsset | null>(null);
  const [draggingAssetId, setDraggingAssetId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [optimizationMessage, setOptimizationMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [next, directorySummary] = await Promise.all([
        listAssets({ status: "all", search, folderId, source: source === "all" || source === "report" ? undefined : source }),
        listAssets({ status: "all", search, folderId }),
      ]);
      setAssets(next.items);
      setStorageUsage(next.storageUsage || null);
      setCatalog(next.catalog || next.items.map((item) => ({ ...item, catalogId: `asset:${item.assetId}`, catalogKind: "asset" as const, sources: [item.currentVersion?.source || "system"] })));
      setReportMappings(next.reportMappings || []);
      setFolders(next.folders || []);
      const summary = directorySummary.catalog || directorySummary.items.map((item) => ({ ...item, catalogId: `asset:${item.assetId}`, catalogKind: "asset" as const, sources: [item.currentVersion?.source || "system"] }));
      const reportBackedAssetIds = new Set((directorySummary.reportMappings || []).map((item) => item.backingAssetId).filter((assetId): assetId is string => Boolean(assetId)));
      const summaryAssets = summary.filter((item) => item.catalogKind === "asset" && !reportBackedAssetIds.has(item.assetId));
      const summaryReports = summary.filter((item) => item.catalogKind === "report");
      setSourceCounts({
        all: summaryAssets.length + summaryReports.length,
        upload: summaryAssets.filter((item) => item.sources.includes("upload")).length,
        conversation: summaryAssets.filter((item) => item.sources.includes("conversation")).length,
        automation: summaryAssets.filter((item) => item.sources.includes("automation")).length,
        report: summaryReports.length,
      });
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setLoading(false);
    }
  }, [folderId, search, source]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!requestedAssetId || loading || selectedId === requestedAssetId) return;
    const requested = assets.find((asset) => asset.assetId === requestedAssetId);
    if (requested) {
      void openFile(requested);
      return;
    }
  }, [assets, loading, requestedAssetId, selectedId]);

  async function openFile(asset: UserAsset) {
    setSelectedId(asset.assetId);
    setError(null);
    if (asset.currentVersionId) filePanel.openAssetPreview({ kind: "asset", assetId: asset.assetId, versionId: asset.currentVersionId, title: asset.name });
  }

  async function handleUpload(files: File[], name: string) {
    if (!files.length) return;
    if (files.some((file) => file.size > 10 * 1024 * 1024)) { setError("单个文件不能超过 10MB"); return; }
    if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) { setError("同一次上传不能超过 20MB"); return; }
    setBusy("upload");
    setError(null);
    setNotice(null);
    setOptimizationMessage(null);
    try {
      const payloads = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (file.type.startsWith("image/") && file.size > 1024 * 1024) setBusy("optimizing");
        const prepared = await prepareImageUpload(file);
        if (prepared.optimized) setOptimizationMessage(`${file.name}: ${formatBytes(prepared.originalBytes)} → ${formatBytes(prepared.candidateBytes)}`);
        payloads.push({ ...prepared, name: files.length === 1 ? (name.trim() || undefined) : undefined, folderId, idempotencyKey: `portal:upload:${createClientId()}:${index}` });
      }
      setBusy("upload");
      const result = files.length === 1 ? await uploadAsset(payloads[0]) : await uploadAssets(payloads);
      const failed = "items" in result ? result.items.filter((item) => !item.ok) : [];
      if (failed.length) setError(failed.map((item) => `${item.fileName}: ${item.ok ? "" : item.error.message}`).join("；"));
      const optimized = payloads.filter((item) => item.optimized);
      if (optimized.length) setNotice({ message: `图片已优化：${optimized.map((item) => `${item.fileName} ${formatBytes(item.originalBytes)} → ${formatBytes(item.candidateBytes)}`).join("；")}。最终文件以服务端校验结果为准。` });
      setUploadOpen(false);
      await refresh();
      if (!("items" in result)) setSelectedId(result.assetId);
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusy(null);
      setOptimizationMessage(null);
    }
  }

  async function handleDownload(asset: UserAsset) {
    if (!asset.currentVersionId) return;
    setBusy(`download:${asset.assetId}`);
    setError(null);
    try {
      downloadAsset(await getAssetVersion(asset.assetId, asset.currentVersionId));
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(asset: UserAsset) {
    if (!window.confirm(`删除“${asset.name}”及其全部历史版本？此操作不可恢复。`)) return;
    setBusy(`delete:${asset.assetId}`);
    setError(null);
    try {
      await deleteAsset(asset.assetId);
      if (selectedId === asset.assetId) setSelectedId(null);
      await refresh();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateFolder(name: string, parentFolderId: string | null) {
    if (!name.trim()) return;
    setBusy("folder:create"); setError(null);
    try {
      const created = await createFolder(name.trim(), parentFolderId);
      await refresh();
      setNotice({ message: `文件夹“${name.trim()}”已创建`, folderId: created.folderId });
      setFolderDialogParentId(undefined);
    }
    catch (cause) { setError(readError(cause)); } finally { setBusy(null); }
  }

  async function handleRenameFolder(folder: FolderRecord, name: string) {
    const nextName = name.trim();
    if (!nextName || nextName === folder.name) { setRenamingFolder(null); return; }
    setBusy(`folder:rename:${folder.folderId}`); setError(null);
    try {
      await renameFolder(folder.folderId, nextName);
      await refresh();
      setNotice({ message: `文件夹已重命名为“${nextName}”` });
      setRenamingFolder(null);
    } catch (cause) { setError(readError(cause)); }
    finally { setBusy(null); }
  }

  async function handleDeleteFolder(folder: FolderRecord) {
    setBusy(`folder:delete:${folder.folderId}`); setError(null);
    try {
      await deleteFolder(folder.folderId);
      await refresh();
      setNotice({ message: `文件夹“${folder.name}”已删除` });
      setDeletingFolder(null);
    } catch (cause) {
      setError(cause instanceof AssetRequestError && cause.code === "ASSET_FOLDER_NOT_EMPTY"
        ? `文件夹“${folder.name}”不是空的，请先移出其中的文件或子文件夹。`
        : readError(cause));
    } finally { setBusy(null); }
  }

  async function handleMove(asset: UserAsset, target: string | null): Promise<boolean> {
    if (asset.folderId === target) return true;
    const destinationName = target ? folders.find((folder) => folder.folderId === target)?.name || "目标文件夹" : "我的文件";
    setBusy(`move:${asset.assetId}`); setError(null);
    try {
      await moveAsset(asset.assetId, target);
      await refresh();
      setNotice({ message: `已将“${asset.name}”移动到“${destinationName}”`, folderId: target || undefined });
      return true;
    }
    catch (cause) { setError(readError(cause)); return false; }
    finally { setBusy(null); }
  }

  function handleAssetDragStart(asset: UserAsset, event: DragEvent<HTMLDivElement>) {
    setDraggingAssetId(asset.assetId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(ASSET_DRAG_MIME, asset.assetId);
    event.dataTransfer.setData("text/plain", asset.assetId);
  }

  function handleAssetDragEnd() {
    setDraggingAssetId(null);
    setDragOverFolderId(null);
  }

  function draggedAssetForEvent(event?: DragEvent<HTMLDivElement>) {
    const assetId = draggingAssetId || event?.dataTransfer.getData(ASSET_DRAG_MIME) || event?.dataTransfer.getData("text/plain");
    return assetId ? assets.find((asset) => asset.assetId === assetId) || null : null;
  }

  function isInternalAssetDrag(event: DragEvent<HTMLDivElement>) {
    return Boolean(draggingAssetId || Array.from(event.dataTransfer.types).includes(ASSET_DRAG_MIME));
  }

  function handleFolderDragOver(folder: FolderRecord, event: DragEvent<HTMLDivElement>) {
    if (!isInternalAssetDrag(event)) {
      setDragOverFolderId(null);
      return;
    }
    event.preventDefault();
    const asset = draggedAssetForEvent();
    if (!asset || asset.folderId === folder.folderId) {
      event.dataTransfer.dropEffect = "none";
      setDragOverFolderId(null);
      return;
    }
    event.dataTransfer.dropEffect = "move";
    setDragOverFolderId(folder.folderId);
  }

  function handleFolderDragLeave(folder: FolderRecord, event: DragEvent<HTMLDivElement>) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget && event.currentTarget.contains(relatedTarget as Node)) return;
    setDragOverFolderId((current) => current === folder.folderId ? null : current);
  }

  async function handleFolderDrop(folder: FolderRecord, event: DragEvent<HTMLDivElement>) {
    if (!isInternalAssetDrag(event)) {
      setDragOverFolderId(null);
      return;
    }
    event.preventDefault();
    const asset = draggedAssetForEvent(event);
    setDraggingAssetId(null);
    setDragOverFolderId(null);
    if (!asset || asset.folderId === folder.folderId) return;
    await handleMove(asset, folder.folderId);
  }

  async function handleDownloadReport(report: UserAssetCatalogItem, mapping?: ReportAssetMapping) {
    if (!mapping?.backingAssetId || !mapping.backingVersionId) return;
    setBusy(`download:${mapping.backingAssetId}`);
    setError(null);
    try {
      downloadAsset(await getAssetVersion(mapping.backingAssetId, mapping.backingVersionId));
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteReport(report: UserAssetCatalogItem, mapping?: ReportAssetMapping) {
    if (!mapping?.backingAssetId) return;
    if (!window.confirm(`删除“${report.name}”及其全部历史版本？此操作不可恢复。`)) return;
    setBusy(`delete:${mapping.backingAssetId}`);
    setError(null);
    try {
      await deleteAsset(mapping.backingAssetId);
      if (selectedId === mapping.backingAssetId) setSelectedId(null);
      await refresh();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusy(null);
    }
  }

  const currentFolder = folderId ? folders.find((folder) => folder.folderId === folderId) || null : null;
  const folderPath = getFolderPath(folders, folderId);
  const folderDepth = folderPath.length;
  const childFolders = folderDepth < 2 ? folders.filter((folder) => folder.parentFolderId === folderId) : [];
  const currentFolderName = currentFolder?.name || "我的文件";
  const reportBackedAssetIds = new Set(reportMappings.map((item) => item.backingAssetId).filter((assetId): assetId is string => Boolean(assetId)));
  const currentAssetIds = new Set(assets.map((asset) => asset.assetId));
  const visibleAssets = source === "report" ? [] : assets.filter((asset) => !reportBackedAssetIds.has(asset.assetId));
  const visibleReports = catalog.filter((item) => {
    if (item.catalogKind !== "report" || (source !== "all" && source !== "report")) return false;
    const mapping = reportMappings.find((candidate) => candidate.mappingId === item.reportMappingId);
    return Boolean(mapping?.backingAssetId && currentAssetIds.has(mapping.backingAssetId));
  });
  const visibleCount = childFolders.length + visibleAssets.length + visibleReports.length;

  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#202123]">
      <div className="hidden sm:block"><PortalSidebar active="assets" /></div>
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#dfe3df] bg-white px-4 py-2 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <FolderOpen size={20} className="shrink-0 text-[#52705f]" />
          <div className="min-w-0"><h1 className="truncate text-base font-semibold">我的文件</h1><p className="truncate text-[11px] text-[#7a827c]">管理、浏览和整理你的文件</p></div>
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5"><button type="button" className="btn-secondary whitespace-nowrap px-2.5 py-1.5 text-xs sm:px-3" onClick={() => void refresh()} disabled={loading} aria-label="刷新文件列表"><RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新</button><button type="button" className="btn-secondary whitespace-nowrap px-2.5 py-1.5 text-xs sm:px-3" onClick={() => setFolderDialogParentId(folderId)} disabled={busy === "folder:create" || folderDepth >= 2} title={folderDepth >= 2 ? "最多支持两层文件夹" : undefined}><Folder size={15} />新建文件夹</button><button type="button" className="btn-primary whitespace-nowrap px-2.5 py-1.5 text-xs sm:px-3" onClick={() => setUploadOpen(true)}><Upload size={15} />上传文件</button></div>
      </header>
      {error ? <div className="flex items-center justify-between border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button></div> : null}
      {notice ? <div className="flex items-center justify-between gap-3 border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-xs text-emerald-800"><span className="min-w-0 truncate">{notice.message}</span><div className="flex shrink-0 items-center gap-1.5">{notice.folderId ? <button type="button" className="rounded px-2 py-1 font-medium hover:bg-emerald-100" onClick={() => { setFolderId(notice.folderId as string); setNotice(null); }}>进入文件夹</button> : null}<button type="button" className="rounded p-1 hover:bg-emerald-100" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button></div></div> : null}

      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-5 sm:px-6 sm:py-7">
        <section className="overflow-hidden rounded-2xl border border-[#dfe3df] bg-white shadow-[0_8px_30px_rgba(55,70,60,0.04)]">
          <div className="border-b border-[#edf0ed] px-5 py-4 sm:px-7">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-1.5" aria-label="文件来源筛选"><span className="mr-1 text-xs font-medium text-[#59635c]">来源</span>
                {([["all", "全部"], ["upload", "我的上传"], ["conversation", "对话保存"], ["automation", "自动化产物"], ["report", "报告"]] as const).map(([value, label]) => <button key={value} type="button" className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${source === value ? "bg-[#edf6ef] font-medium text-[#45684e]" : "text-[#7a827c] hover:bg-[#f3f5f3]"}`} onClick={() => setSource(value)}>{label}<span className={`min-w-4 rounded-full px-1 text-center text-[10px] leading-4 ${source === value ? "bg-white/70 text-[#45684e]" : "bg-[#f0f3f0] text-[#7a827c]"}`}>{sourceCounts[value]}</span></button>)}
              </div>
              <label className="relative w-full sm:max-w-xs"><Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-[#8b948c]" /><input className="input-base h-10 w-full !pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名称" aria-label="搜索文件名称" /></label>
            </div>
            <nav aria-label="文件夹路径" className="mt-3 flex min-w-0 flex-wrap items-center gap-1 border-t border-[#f0f2f0] pt-3 text-xs"><button type="button" className={`inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 ${!folderId ? "bg-[#edf6ef] font-medium text-[#45684e]" : "text-[#7a827c] hover:bg-[#f3f5f3]"}`} onClick={() => setFolderId(null)} aria-current={!folderId ? "page" : undefined}><FolderOpen size={14} className="shrink-0" /><span className="truncate">我的文件</span></button>{folderPath.map((folder) => <span key={folder.folderId} className="inline-flex min-w-0 items-center gap-1"><ChevronRight size={14} className="shrink-0 text-[#adb5ae]" /><button type="button" className={`max-w-[12rem] truncate rounded-md px-2 py-1 ${folder.folderId === folderId ? "bg-[#edf6ef] font-medium text-[#45684e]" : "text-[#7a827c] hover:bg-[#f3f5f3]"}`} onClick={() => setFolderId(folder.folderId)} aria-current={folder.folderId === folderId ? "page" : undefined}>{folder.name}</button></span>)}</nav>
          </div>

          {loading && visibleCount === 0 ? <div className="flex min-h-[420px] items-center justify-center px-6 py-16 text-sm text-[#7a827c]">正在加载文件...</div> : visibleCount === 0 ? <EmptyFiles folderName={currentFolderName} canCreateFolder={folderDepth < 2} onUpload={() => setUploadOpen(true)} onCreateFolder={() => setFolderDialogParentId(folderId)} /> : <div>
            <div className="hidden grid-cols-[minmax(0,1fr)_150px_100px] items-center gap-4 border-b border-[#edf0ed] px-5 py-3 text-xs text-[#909991] sm:grid sm:px-7"><span>文件</span><span>更新时间</span><span className="text-right">操作</span></div>
            <div>{childFolders.map((folder) => <FolderRow key={folder.folderId} folder={folder} dropActive={dragOverFolderId === folder.folderId} busy={busy} onEnter={() => setFolderId(folder.folderId)} onRename={() => setRenamingFolder(folder)} onDelete={() => setDeletingFolder(folder)} onDragOver={(event) => handleFolderDragOver(folder, event)} onDragLeave={(event) => handleFolderDragLeave(folder, event)} onDrop={(event) => void handleFolderDrop(folder, event)} />)}{visibleAssets.map((asset) => <FileRow key={asset.assetId} asset={asset} selected={selectedId === asset.assetId} dragging={draggingAssetId === asset.assetId} busy={busy} onOpen={() => void openFile(asset)} onDownload={() => void handleDownload(asset)} onDelete={() => void handleDelete(asset)} onMove={() => setMovingAsset(asset)} onDragStart={(event) => handleAssetDragStart(asset, event)} onDragEnd={handleAssetDragEnd} />)}{visibleReports.map((report) => { const mapping = reportMappings.find((item) => item.mappingId === report.reportMappingId); const backingAsset = mapping?.backingAssetId ? assets.find((asset) => asset.assetId === mapping.backingAssetId) : undefined; return <ReportRow key={report.catalogId} report={report} mapping={mapping} backingAsset={backingAsset} dragging={Boolean(backingAsset && draggingAssetId === backingAsset.assetId)} busy={busy} onOpen={() => filePanel.openAssetPreview({ kind: "report", mappingId: report.reportMappingId || report.catalogId.replace(/^report:/, ""), title: report.name })} onDownload={() => void handleDownloadReport(report, mapping)} onDelete={() => void handleDeleteReport(report, mapping)} onMove={backingAsset ? () => setMovingAsset(backingAsset) : undefined} onDragStart={backingAsset ? (event) => handleAssetDragStart(backingAsset, event) : undefined} onDragEnd={handleAssetDragEnd} />; })}</div>
          </div>}
        </section>
        {storageUsage ? <div className="mt-auto pt-5"><div className="w-full max-w-[220px]"><StorageUsageIndicator usage={storageUsage} /></div></div> : null}
      </main>

      {uploadOpen ? <UploadDialog busy={busy} destination={currentFolderName} optimizationMessage={optimizationMessage} onClose={() => setUploadOpen(false)} onSubmit={(files, name) => void handleUpload(files, name)} /> : null}
      {folderDialogParentId !== undefined ? <FolderDialog busy={busy === "folder:create"} parentFolderId={folderDialogParentId} folders={folders} onClose={() => setFolderDialogParentId(undefined)} onSubmit={(name) => void handleCreateFolder(name, folderDialogParentId)} /> : null}
      {renamingFolder ? <RenameFolderDialog folder={renamingFolder} busy={busy === `folder:rename:${renamingFolder.folderId}`} onClose={() => setRenamingFolder(null)} onSubmit={(name) => void handleRenameFolder(renamingFolder, name)} /> : null}
      {deletingFolder ? <DeleteFolderDialog folder={deletingFolder} busy={busy === `folder:delete:${deletingFolder.folderId}`} onClose={() => setDeletingFolder(null)} onConfirm={() => void handleDeleteFolder(deletingFolder)} /> : null}
      {movingAsset ? <MoveDialog asset={movingAsset} folders={folders} busy={busy === `move:${movingAsset.assetId}`} onClose={() => setMovingAsset(null)} onMove={(target) => void handleMove(movingAsset, target).then((moved) => { if (moved) setMovingAsset(null); })} /> : null}
      </div>
    </div>
  );
}

function FolderDialog({ busy, parentFolderId, folders, onClose, onSubmit }: { busy: boolean; parentFolderId: string | null; folders: Array<{ folderId: string; name: string }>; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(""); const inputRef = useRef<HTMLInputElement | null>(null); const dialogRef = useDialogInteractions<HTMLFormElement>(onClose, inputRef);
  const parentName = parentFolderId ? folders.find((folder) => folder.folderId === parentFolderId)?.name : null;
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-3"><form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSubmit(name); }}><div className="flex items-start justify-between"><div><h2 id="folder-dialog-title" className="text-lg font-semibold">新建文件夹</h2><p className="mt-1 text-xs text-[#7a827c]">{parentName ? `创建在“${parentName}”中` : "创建在根目录"}</p></div><button type="button" className="rounded-md p-1.5 hover:bg-[#f1f5f1]" onClick={onClose} aria-label="关闭"><X size={17} /></button></div><label className="mt-5 block"><span className="text-sm font-medium">文件夹名称</span><input ref={inputRef} className="input-base mt-1" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例如：行业跟踪" /></label><div className="mt-6 flex justify-end gap-2"><button type="button" className="btn-secondary px-4 py-2" onClick={onClose}>取消</button><button type="submit" className="btn-primary px-4 py-2" disabled={!name.trim() || busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Folder size={15} />}创建</button></div></form></div>;
}

function RenameFolderDialog({ folder, busy, onClose, onSubmit }: { folder: FolderRecord; busy: boolean; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useDialogInteractions<HTMLFormElement>(onClose, inputRef);
  useEffect(() => { inputRef.current?.select(); }, []);
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-3"><form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="rename-folder-dialog-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSubmit(name); }}><div className="flex items-start justify-between"><div><h2 id="rename-folder-dialog-title" className="text-lg font-semibold">重命名文件夹</h2><p className="mt-1 text-xs text-[#7a827c]">只会更改分类名称，不影响其中的文件。</p></div><button type="button" className="rounded-md p-1.5 hover:bg-[#f1f5f1]" onClick={onClose} aria-label="关闭"><X size={17} /></button></div><label className="mt-5 block"><span className="text-sm font-medium">文件夹名称</span><input ref={inputRef} className="input-base mt-1" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} /></label><div className="mt-6 flex justify-end gap-2"><button type="button" className="btn-secondary px-4 py-2" onClick={onClose}>取消</button><button type="submit" className="btn-primary px-4 py-2" disabled={!name.trim() || name.trim() === folder.name || busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}保存</button></div></form></div>;
}

function DeleteFolderDialog({ folder, busy, onClose, onConfirm }: { folder: FolderRecord; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialogInteractions<HTMLDivElement>(onClose, cancelRef);
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-3"><div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-folder-dialog-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"><div className="flex items-start justify-between"><div><h2 id="delete-folder-dialog-title" className="text-lg font-semibold">删除文件夹</h2><p className="mt-1 text-xs text-[#7a827c]">“{folder.name}”</p></div><button type="button" className="rounded-md p-1.5 hover:bg-[#f1f5f1]" onClick={onClose} aria-label="关闭"><X size={17} /></button></div><p className="mt-5 text-sm leading-6 text-[#505953]">仅空文件夹可以删除。文件夹中的文件不会被连带删除；如果其中还有内容，请先将内容移出。</p><div className="mt-6 flex justify-end gap-2"><button ref={cancelRef} type="button" className="btn-secondary px-4 py-2" onClick={onClose}>取消</button><button type="button" className="inline-flex items-center gap-2 rounded-md bg-[#9a514a] px-4 py-2 text-sm font-medium text-white hover:bg-[#87453f] disabled:opacity-50" disabled={busy} onClick={onConfirm}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}删除文件夹</button></div></div></div>;
}

function MoveDialog({ asset, folders, busy, onClose, onMove }: { asset: UserAsset; folders: Array<{ folderId: string; parentFolderId: string | null; name: string }>; busy: boolean; onClose: () => void; onMove: (folderId: string | null) => void }) {
  const [target, setTarget] = useState<string | null>(asset.folderId); const closeRef = useRef<HTMLButtonElement | null>(null); const dialogRef = useDialogInteractions<HTMLDivElement>(onClose, closeRef);
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-3"><div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"><div className="flex items-start justify-between"><div><h2 id="move-dialog-title" className="text-lg font-semibold">移动文件</h2><p className="mt-1 truncate text-xs text-[#7a827c]">{asset.name}</p></div><button ref={closeRef} type="button" className="rounded-md p-1.5 hover:bg-[#f1f5f1]" onClick={onClose} aria-label="关闭"><X size={17} /></button></div><div className="mt-5 max-h-64 space-y-1 overflow-auto">{[{ folderId: null, parentFolderId: null, name: "根目录" }, ...folders].map((folder) => <label key={folder.folderId || "root"} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-[#f4f8f4]"><input type="radio" name="folder" checked={target === folder.folderId} onChange={() => setTarget(folder.folderId)} /><span>{folder.parentFolderId ? "  " : ""}{folder.name}</span></label>)}</div><div className="mt-6 flex justify-end gap-2"><button type="button" className="btn-secondary px-4 py-2" onClick={onClose}>取消</button><button type="button" className="btn-primary px-4 py-2" disabled={busy} onClick={() => onMove(target)}>{busy ? <Loader2 size={15} className="animate-spin" /> : "移动到此处"}</button></div></div></div>;
}

function FolderRow({ folder, dropActive, busy, onEnter, onRename, onDelete, onDragOver, onDragLeave, onDrop }: { folder: FolderRecord; dropActive: boolean; busy: string | null; onEnter: () => void; onRename: () => void; onDelete: () => void; onDragOver: (event: DragEvent<HTMLDivElement>) => void; onDragLeave: (event: DragEvent<HTMLDivElement>) => void; onDrop: (event: DragEvent<HTMLDivElement>) => void }) {
  return <div data-folder-id={folder.folderId} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#edf0ed] px-5 py-3.5 transition last:border-b-0 sm:grid-cols-[minmax(0,1fr)_150px_100px] sm:gap-4 sm:px-7 ${dropActive ? "bg-[#edf6ef] ring-1 ring-inset ring-[#8fb39a]" : "hover:bg-[#fafcfb]"}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} aria-label={dropActive ? `松开以移动到文件夹 ${folder.name}` : `文件夹 ${folder.name}`}>
    <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={onEnter} aria-label={`进入文件夹 ${folder.name}`}>
      <span data-primary-icon className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f2f5f1] text-[#52705f]"><Folder size={20} /></span>
      <span className="min-w-0 truncate text-sm font-medium text-[#303632]">{folder.name}<span className={dropActive ? "mt-1 block truncate text-xs font-normal text-[#45684e]" : "sr-only"}>松开以移动</span></span>
    </button>
    <span className="hidden text-xs text-[#7a827c] sm:block">{folder.updatedAt ? formatDate(folder.updatedAt) : "文件夹"}</span>
    <div className="flex items-center justify-end"><FolderActions folder={folder} busy={busy} onRename={onRename} onDelete={onDelete} /></div>
  </div>;
}

function FolderActions({ folder, busy, onRename, onDelete }: { folder: FolderRecord; busy: string | null; onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false); };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("pointerdown", handlePointerDown); document.removeEventListener("keydown", handleKeyDown); };
  }, [open]);
  const invoke = (action: () => void) => { setOpen(false); action(); };
  const isBusy = busy === `folder:rename:${folder.folderId}` || busy === `folder:delete:${folder.folderId}`;
  return <div ref={menuRef} className="relative"><button type="button" className="rounded-md p-2 text-[#6d776f] hover:bg-[#f0f5f0] disabled:opacity-40" onClick={() => setOpen((current) => !current)} disabled={isBusy} aria-label={`文件夹更多操作：${folder.name}`} aria-expanded={open} title="更多操作">{isBusy ? <Loader2 size={17} className="animate-spin" /> : <MoreHorizontal size={17} />}</button>{open ? <div className="absolute bottom-full right-0 z-30 mb-1 w-32 overflow-hidden rounded-lg border border-[#dfe3df] bg-white p-1 shadow-lg"><button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#303632] hover:bg-[#f3f7f3]" onClick={() => invoke(onRename)}><Pencil size={14} />重命名</button><button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#8a625f] hover:bg-[#fbefed]" onClick={() => invoke(onDelete)}><Trash2 size={14} />删除</button></div> : null}</div>;
}

function FileRow({ asset, selected, dragging, busy, onOpen, onDownload, onDelete, onMove, onDragStart, onDragEnd }: { asset: UserAsset; selected: boolean; dragging: boolean; busy: string | null; onOpen: () => void; onDownload: () => void; onDelete: () => void; onMove: () => void; onDragStart: (event: DragEvent<HTMLDivElement>) => void; onDragEnd: () => void }) {
  const current = asset.currentVersion;
  return <div data-asset-id={asset.assetId} draggable={!busy} onDragStart={onDragStart} onDragEnd={onDragEnd} aria-grabbed={dragging ? "true" : "false"} className={`group grid ${busy ? "cursor-default" : "cursor-grab"} grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#edf0ed] px-5 py-3.5 transition last:border-b-0 active:cursor-grabbing sm:grid-cols-[minmax(0,1fr)_150px_100px] sm:gap-4 sm:px-7 ${dragging ? "bg-[#f4f9f5] opacity-60" : selected ? "bg-[#f4f9f5]" : "hover:bg-[#fafcfb]"}`}>
    <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={onOpen} aria-label={`打开文件 ${asset.name}`}>
      <span data-primary-icon className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#edf6ef] text-[#52705f]"><AssetIcon format={current?.format} /></span>
      <span className="min-w-0"><span className="block truncate text-sm font-medium text-[#303632]">{asset.name}</span><span className="mt-1 block truncate text-xs text-[#8a938c]">{current ? `${current.fileName} · ${formatBytes(current.sizeBytes)}` : "文件内容不可用"}</span></span>
    </button>
    <span className="hidden text-xs text-[#7a827c] sm:block">{formatDate(asset.updatedAt)}</span>
    <div className="flex items-center justify-end gap-1"><button type="button" className="rounded-md p-2 text-[#6d776f] hover:bg-[#f0f5f0] disabled:opacity-40" onClick={onDownload} disabled={!current || busy === `download:${asset.assetId}`} aria-label={`下载 ${asset.name}`} title="下载文件">{busy === `download:${asset.assetId}` ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}</button><AssetActions name={asset.name} onMove={onMove} onDelete={onDelete} deleteBusy={busy === `delete:${asset.assetId}`} /></div>
  </div>;
}

function ReportRow({ report, mapping, backingAsset, dragging, busy, onOpen, onDownload, onDelete, onMove, onDragStart, onDragEnd }: { report: UserAssetCatalogItem; mapping?: ReportAssetMapping; backingAsset?: UserAsset; dragging: boolean; busy: string | null; onOpen: () => void; onDownload: () => void; onDelete: () => void; onMove?: () => void; onDragStart?: (event: DragEvent<HTMLDivElement>) => void; onDragEnd: () => void }) {
  const assetId = mapping?.backingAssetId;
  const canManage = Boolean(assetId && mapping?.backingVersionId);
  const canMove = Boolean(backingAsset && onMove && onDragStart);
  return <div data-asset-id={backingAsset?.assetId} draggable={canMove && !busy} onDragStart={onDragStart} onDragEnd={onDragEnd} aria-grabbed={dragging ? "true" : "false"} className={`group grid ${canMove && !busy ? "cursor-grab" : "cursor-default"} grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#edf0ed] px-5 py-3.5 transition last:border-b-0 active:cursor-grabbing sm:grid-cols-[minmax(0,1fr)_150px_100px] sm:gap-4 sm:px-7 ${dragging ? "bg-[#f4f9f5] opacity-60" : "hover:bg-[#fafcfb]"}`}>
    <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={onOpen} aria-label={`打开报告 ${report.name}`}>
      <span data-primary-icon className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#edf6ef] text-[#52705f]"><FileText size={20} /></span>
      <span className="min-w-0"><span className="block truncate text-sm font-medium text-[#303632]">{report.name}</span><span className="mt-1 block truncate text-xs text-[#8a938c]">报告 · {mapping ? `${mapping.fileName} · ${formatBytes(mapping.sizeBytes)}` : "报告文件"}</span></span>
    </button>
    <span className="hidden text-xs text-[#7a827c] sm:block">{formatDate(report.createdAt)}</span>
    <div className="flex items-center justify-end gap-1"><button type="button" className="rounded-md p-2 text-[#6d776f] hover:bg-[#f0f5f0] disabled:opacity-40" onClick={onDownload} disabled={!canManage || busy === `download:${assetId}`} aria-label={`下载 ${report.name}`} title="下载文件">{busy === `download:${assetId}` ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}</button><AssetActions name={report.name} onMove={canMove ? onMove : undefined} onDelete={onDelete} deleteDisabled={!assetId} deleteBusy={Boolean(assetId && busy === `delete:${assetId}`)} /></div>
  </div>;
}

function AssetActions({ name, onMove, onDelete, deleteDisabled = false, deleteBusy = false }: { name: string; onMove?: () => void; onDelete: () => void; deleteDisabled?: boolean; deleteBusy?: boolean }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const invoke = (action: () => void) => { setOpen(false); action(); };
  return <div ref={menuRef} className="relative"><button type="button" className="rounded-md p-2 text-[#6d776f] hover:bg-[#f0f5f0]" onClick={() => setOpen((current) => !current)} aria-label={`更多操作：${name}`} aria-expanded={open} title="更多操作"><MoreHorizontal size={17} /></button>{open ? <div className="absolute bottom-full right-0 z-30 mb-1 w-36 overflow-hidden rounded-lg border border-[#dfe3df] bg-white p-1 shadow-lg">{onMove ? <button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#303632] hover:bg-[#f3f7f3]" onClick={() => invoke(onMove)}><FolderInput size={14} />移动</button> : null}<button type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#8a625f] hover:bg-[#fbefed] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => invoke(onDelete)} disabled={deleteDisabled || deleteBusy}>{deleteBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}删除</button></div> : null}</div>;
}

function StorageUsageIndicator({ usage }: { usage: StorageUsage }) {
  const used = formatStorageBytes(usage.usedBytes);
  const limit = formatStorageBytes(usage.limitBytes);
  const percent = usage.limitBytes > 0 ? Math.min(100, usage.usedBytes / usage.limitBytes * 100) : 0;
  return <div aria-label={`存储空间 ${used} / ${limit}`}>
    <div className="h-1.5 overflow-hidden rounded-full bg-[#dfe6df]"><div className="h-full min-w-px bg-[#6d9376] transition-all" style={{ width: `${percent}%` }} /></div>
    <p className="mt-2 text-[11px] text-[#737d76]">存储空间 <span className="text-[#555f58]">{used} / {limit}</span></p>
  </div>;
}

function UploadDialog({ busy, destination, optimizationMessage, onClose, onSubmit }: { busy: string | null; destination: string; optimizationMessage: string | null; onClose: () => void; onSubmit: (files: File[], name: string) => void }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialogInteractions<HTMLFormElement>(onClose, closeButtonRef);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  return <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/25 p-3 sm:items-center"><form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl sm:p-7" onSubmit={(event) => { event.preventDefault(); if (files.length) onSubmit(files, name); }}><div className="flex items-start justify-between"><div><h2 id="upload-dialog-title" className="text-lg font-semibold">上传文件</h2><p className="mt-1 text-xs text-[#7a827c]">目标位置：<span className="font-medium text-[#526058]">{destination}</span></p><p className="mt-1 text-xs text-[#7a827c]">单个文件 10MB，同次上传合计 20MB。</p></div><button ref={closeButtonRef} type="button" className="rounded-md p-1.5 hover:bg-[#f1f5f1]" onClick={onClose} aria-label="关闭上传"><X size={17} /></button></div><label className="mt-5 block"><span className="text-sm font-medium">文件名称（单文件可选）</span><input className="input-base mt-1" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：行业跟踪表" /></label><label className="mt-4 block"><span className="text-sm font-medium">选择文件</span><span className="mt-1 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-[#becabf] bg-[#fbfcfb] px-3 py-3 text-sm text-[#667169] hover:bg-[#f4f8f4]"><Upload size={16} /><span className="min-w-0 flex-1 truncate">{files.length ? files.map((file) => `${file.name} · ${formatBytes(file.size)}`).join("、") : "选择一个或多个文件"}</span><input type="file" multiple className="sr-only" onChange={(event) => setFiles(Array.from(event.target.files || []))} /></span></label>{busy === "optimizing" ? <p className="mt-3 text-xs text-[#52705f]">正在优化图片</p> : null}{optimizationMessage ? <p className="mt-2 text-xs text-[#68726b]">{optimizationMessage}</p> : null}<div className="mt-6 flex justify-end gap-2"><button type="button" className="btn-secondary px-4 py-2" onClick={onClose}>取消</button><button type="submit" className="btn-primary px-4 py-2" disabled={!files.length || Boolean(busy)}>{busy === "optimizing" ? "正在优化图片" : busy ? <><Loader2 size={15} className="animate-spin" />上传中</> : <><Upload size={15} />上传文件</>}</button></div></form></div>;
}

const FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])";

function useDialogInteractions<T extends HTMLElement>(onClose: () => void, initialFocusRef: RefObject<HTMLElement | null>) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let mounted = true;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => {
      if (mounted) initialFocusRef.current?.focus();
    });
    return () => {
      mounted = false;
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [initialFocusRef]);

  return dialogRef;
}

function EmptyFiles({ folderName, canCreateFolder, onUpload, onCreateFolder }: { folderName: string; canCreateFolder: boolean; onUpload: () => void; onCreateFolder: () => void }) {
  return <div className="flex min-h-[420px] flex-col items-center justify-center px-6 py-16 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#edf6ef] text-[#7fa18a]"><FolderOpen size={28} /></div><h3 className="mt-5 text-lg font-semibold">“{folderName}”中还没有文件</h3><p className="mt-2 max-w-sm text-sm leading-6 text-[#7a827c]">上传文件后，它们会显示在这里，方便你随时浏览和管理。</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" className="btn-primary px-4 py-2" onClick={onUpload}><Upload size={15} />上传文件</button><button type="button" className="btn-secondary px-4 py-2" onClick={onCreateFolder} disabled={!canCreateFolder} title={!canCreateFolder ? "最多支持两层文件夹" : undefined}><Folder size={15} />新建文件夹</button></div></div>;
}

function getFolderPath(folders: FolderRecord[], folderId: string | null): FolderRecord[] {
  if (!folderId) return [];
  const path: FolderRecord[] = [];
  const seen = new Set<string>();
  let current = folders.find((folder) => folder.folderId === folderId);
  while (current && !seen.has(current.folderId)) {
    path.unshift(current);
    seen.add(current.folderId);
    current = current.parentFolderId ? folders.find((folder) => folder.folderId === current?.parentFolderId) : undefined;
  }
  return path;
}

function AssetIcon({ format }: { format?: string }) { return format && ["png", "jpeg", "webp", "svg"].includes(format) ? <FileImage size={20} /> : format && ["markdown", "html", "csv"].includes(format) ? <FileText size={20} /> : <File size={20} />; }
function FileTypeBadge({ format }: { format?: string }) { return <span className="rounded-md bg-[#f1f4f1] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[#68726b]">{format || "文件"}</span>; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }); }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function formatStorageBytes(bytes: number) { return formatBytes(bytes).replace(/\.0 (?=KB|MB)/, " "); }
function readError(error: unknown) { return error instanceof Error ? error.message : "文件请求失败，请稍后重试"; }
