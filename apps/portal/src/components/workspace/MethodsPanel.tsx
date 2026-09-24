"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Check, GitCompare, Loader2, Pencil, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import type { MethodAssetCardView, MethodCardView, MethodDetailView } from "@/lib/workspace-api";
import { WorkspaceRequestError, addMethodVersion, adoptMethod, clearMethodWorkingCopy, createMethod, diffMethod, getMethod, getMethodAssetVersion, getMethodWorkingCopy, listMethodAssets, listMethods, saveMethodAssetVersion, saveMethodWorkingCopy } from "./api";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

function methodCategory(asset: MethodAssetCardView): string {
  const value = `${asset.fileName} ${asset.name}`.toLowerCase();
  if (value.includes("risk") || value.includes("风控") || value.includes("风险")) return "风控资料";
  if (value.includes("technical") || value.includes("技术")) return "技术面资料";
  if (value.includes("fundamental") || value.includes("基本面")) return "基本面资料";
  if (value.includes("macro") || value.includes("宏观")) return "宏观资料";
  if (value.includes("strategy") || value.includes("策略")) return "策略资料";
  return "其他投资资料";
}

const METHOD_CATEGORY_FILTERS = ["全部", "策略资料", "基本面资料", "技术面资料", "宏观资料", "风控资料", "其他投资资料"] as const;

export function selectDiffVersion(current: { from: string; to: string } | null, versionId: string): { from: string; to: string } {
  if (!current || current.to) return { from: versionId, to: "" };
  if (current.from === versionId) return current;
  return { from: current.from, to: versionId };
}

function StatusBadge({ method }: { method: MethodCardView }) {
  if (method.status === "retired") return <span className="rounded bg-[#eceae4] px-1.5 py-0.5 text-[11px] text-[#7a827c]">已停用</span>;
  if (method.currentVersionId) return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">已采用 v{method.currentVersionNumber ?? "?"}</span>;
  return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">未采用</span>;
}

export function MethodsPanel({ onOpenAsset }: { onOpenAsset: (assetId: string) => void }) {
  const [methods, setMethods] = useState<MethodCardView[]>([]);
  const [assets, setAssets] = useState<MethodAssetCardView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<(typeof METHOD_CATEGORY_FILTERS)[number]>("全部");
  const [editingAsset, setEditingAsset] = useState<MethodAssetCardView | null>(null);
  const [assetDraft, setAssetDraft] = useState("");
  const [assetDraftVersionId, setAssetDraftVersionId] = useState<string | null>(null);
  const [assetDraftFileName, setAssetDraftFileName] = useState("");
  const [assetDraftBaseVersionId, setAssetDraftBaseVersionId] = useState<string | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, assetData] = await Promise.all([listMethods(), listMethodAssets()]);
      setMethods(data.items);
      setAssets(assetData.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function beginAssetEdit(asset: MethodAssetCardView) {
    if (!asset.currentVersionId) return;
    setAssetBusy(true);
    setError(null);
    try {
      const version = await getMethodAssetVersion(asset.assetId, asset.currentVersionId);
      const bytes = Uint8Array.from(atob(version.base64), (char) => char.charCodeAt(0));
      const versionText = new TextDecoder().decode(bytes);
      const working = await getMethodWorkingCopy(asset.assetId);
      // 服务端工作副本优先；没有时回落到浏览器遗留草稿（旧 localStorage），
      // 再回落到当前版本正文。首次保存后 localStorage 会被清掉，此后只有服务端一份。
      const legacyDraft = window.localStorage.getItem(`method-working-copy:${asset.assetId}`);
      if (working.exists && working.draftText != null) {
        setAssetDraft(working.draftText);
        setAssetDraftBaseVersionId(working.baseVersionId ?? null);
      } else if (legacyDraft != null) {
        setAssetDraft(legacyDraft);
        setAssetDraftBaseVersionId(null);
      } else {
        setAssetDraft(versionText);
        setAssetDraftBaseVersionId(version.versionId);
      }
      setAssetDraftVersionId(version.versionId);
      setAssetDraftFileName(version.fileName);
      setEditingAsset(asset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开编辑器");
    } finally {
      setAssetBusy(false);
    }
  }

  async function saveAssetWorkingCopy() {
    if (!editingAsset || !assetDraft.trim()) return;
    setAssetBusy(true);
    setError(null);
    try {
      await saveMethodWorkingCopy(editingAsset.assetId, {
        draftText: assetDraft,
        ...(assetDraftBaseVersionId ? { baseVersionId: assetDraftBaseVersionId } : {}),
      });
      window.localStorage.removeItem(`method-working-copy:${editingAsset.assetId}`);
      setEditingAsset(null);
      await refresh();
      setNotice("工作副本已保存到服务端，不会生成新版本。");
    } catch (e) {
      // 服务端暂不可用时退回本地暂存，保住用户输入，但明确告知只是本地。
      if (e instanceof WorkspaceRequestError) {
        window.localStorage.setItem(`method-working-copy:${editingAsset.assetId}`, assetDraft);
        setEditingAsset(null);
        setNotice(`服务端暂不可用（${e.message}），修改已暂存在本浏览器。`);
        return;
      }
      setError(e instanceof Error ? e.message : "保存工作副本失败");
    } finally {
      setAssetBusy(false);
    }
  }

  async function saveAssetAsVersion() {
    if (!editingAsset || !assetDraftVersionId || !assetDraft.trim()) return;
    setAssetBusy(true);
    setError(null);
    try {
      const encodedBytes = new TextEncoder().encode(assetDraft);
      let binary = "";
      for (const byte of encodedBytes) binary += String.fromCharCode(byte);
      const encoded = btoa(binary);
      await saveMethodAssetVersion({ assetId: editingAsset.assetId, fileName: assetDraftFileName, mimeType: "text/markdown", base64: encoded, expectedVersionId: assetDraftVersionId, idempotencyKey: `portal:method-asset-version:${editingAsset.assetId}:${Date.now()}` });
      setEditingAsset(null);
      window.localStorage.removeItem(`method-working-copy:${editingAsset.assetId}`);
      try {
        await clearMethodWorkingCopy(editingAsset.assetId);
      } catch {
        // 版本已落库；工作副本清理失败不阻塞，列表徽标会提示仍有未发布修改。
      }
      await refresh();
      setNotice("已保存为新版本；原版本仍保留在历史记录中。");
    } catch (e) {
      setError(e instanceof WorkspaceRequestError ? e.message : "保存新版本失败");
    } finally {
      setAssetBusy(false);
    }
  }

  if (selectedId) {
    return (
      <MethodDetail
        methodId={selectedId}
        onBack={() => {
          setSelectedId(null);
          void refresh();
        }}
        onNotice={setNotice}
        onOpenAsset={onOpenAsset}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#7a827c]">这里聚合你的投资策略、偏好、风控和分析资料；文件被明确采用后，才会成为运行依据。</p>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新
          </button>
          {methods.length > 0 ? <CreateMethodDialog
            onCreated={async (methodId) => { setSelectedId(methodId); await refresh(); }}
            onError={setError}
          /> : null}
        </div>
      </div>
      {error ? (
        <div className="flex items-center justify-between border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button>
        </div>
      ) : null}
      {notice ? (
        <div className="flex items-center justify-between border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button>
        </div>
      ) : null}
      {loading ? (
        <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载方法列表…</div>
      ) : methods.length === 0 && assets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#dfe3df] bg-white px-6 py-10 text-center text-sm text-[#7a827c]">
          还没有投资策略或方法资料。
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {assets.length > 0 ? <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">投资相关文件（{assets.length}）</h3><span className="text-[11px] text-[#7a827c]">历史候选，尚未自动采用</span></div>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="投资文件分类">
              {METHOD_CATEGORY_FILTERS.map((category) => {
                const count = category === "全部" ? assets.length : assets.filter((asset) => methodCategory(asset) === category).length;
                return <button key={category} type="button" role="tab" aria-selected={categoryFilter === category} className={`rounded-full border px-3 py-1 text-xs transition ${categoryFilter === category ? "border-[#52705f] bg-[#52705f] text-white" : "border-[#dfe3df] bg-white text-[#5f6660] hover:border-[#52705f] hover:text-[#52705f]"}`} onClick={() => setCategoryFilter(category)}>{category.replace("资料", "")} <span className={categoryFilter === category ? "text-white/75" : "text-[#9aa19b]"}>{count}</span></button>;
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {assets.filter((asset) => categoryFilter === "全部" || methodCategory(asset) === categoryFilter).map((asset) => (
                  <div key={asset.assetId} className="flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4 transition hover:border-[#52705f] hover:shadow-sm">
                    <div className="flex items-center justify-between gap-2"><button type="button" className="flex min-w-0 items-center gap-1.5 truncate text-left text-sm font-semibold" onClick={() => onOpenAsset(asset.assetId)} title="点击预览文件"><BookOpen size={15} className="shrink-0 text-[#52705f]" />{asset.name}</button><div className="flex items-center gap-1.5"><span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">候选</span>{asset.workingCopyUpdatedAt ? <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800" title={`未发布修改 ${formatDate(asset.workingCopyUpdatedAt)}`}>未发布修改</span> : null}<button type="button" className="rounded p-1 text-[#52705f] hover:bg-[#edf6ef]" onClick={() => void beginAssetEdit(asset)} disabled={assetBusy} aria-label={`编辑工作副本：${asset.name}`} title="编辑工作副本"><Pencil size={14} /></button></div></div>
                    <p className="font-mono text-[11px] text-[#7a827c]">{asset.fileName}</p>
                    <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-[#7a827c]"><span>来源：{asset.source === "restore" ? "历史镜像" : asset.source}</span><span>点击预览</span><span>最近变更 {formatDate(asset.updatedAt)}</span></div>
                  </div>
              ))}
            </div>
          </section> : null}
          {methods.length > 0 ? <section className="flex flex-col gap-2"><h3 className="text-sm font-semibold">已登记的方法体系（{methods.length}）</h3><div className="grid gap-3 sm:grid-cols-2">
          {methods.map((method) => (
            <button
              key={method.methodId}
              type="button"
              className="flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4 text-left transition hover:border-[#52705f]"
              onClick={() => setSelectedId(method.methodId)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold"><BookOpen size={15} className="shrink-0 text-[#52705f]" />{method.name}</span>
                <StatusBadge method={method} />
              </div>
              {method.description ? <p className="line-clamp-2 text-xs text-[#5f6660]">{method.description}</p> : null}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#7a827c]">
                <span>最近变更 {formatDate(method.updatedAt)}</span>
                <span>{method.taskBindingCount > 0 ? `${method.taskBindingCount} 个自动化在用` : "暂无自动化绑定"}</span>
                <span>{method.versionCount} 个版本</span>
                {method.pendingDraft ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">待确认 v{method.pendingDraft.versionNumber}</span> : null}
              </div>
            </button>
          ))}
          </div></section> : null}
        </div>
      )}
      {editingAsset ? <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="编辑工作副本">
        <div className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-3 rounded-lg bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">编辑工作副本</h2><p className="mt-1 text-xs text-[#7a827c]">{editingAsset.name} · 普通保存不会生成版本</p></div><button type="button" className="rounded p-1 hover:bg-[#eceeeb]" onClick={() => setEditingAsset(null)} aria-label="关闭编辑器"><X size={16} /></button></div>
          {assetDraftBaseVersionId && assetDraftVersionId && assetDraftBaseVersionId !== assetDraftVersionId ? (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">此工作副本基于较早的版本编辑；「保存为新版本」将以当前编辑内容整体追加为新版本。</p>
          ) : null}
          <textarea className="input min-h-[420px] flex-1 font-mono text-xs" value={assetDraft} onChange={(event) => setAssetDraft(event.target.value)} aria-label="工作副本文本" />
          <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-[#7a827c]">普通保存写入服务端工作副本（未发布修改，Agent 可见）；只有“保存为新版本”才进入版本历史。</span><div className="flex gap-2"><button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void saveAssetWorkingCopy()} disabled={assetBusy || !assetDraft.trim()}>保存修改</button><button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => void saveAssetAsVersion()} disabled={assetBusy || !assetDraft.trim()}>{assetBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}保存为新版本</button></div></div>
        </div>
      </div> : null}
    </div>
  );
}

function CreateMethodDialog({ onCreated, onError }: { onCreated: (methodId: string) => void | Promise<void>; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => setOpen(true)}><Plus size={15} />新建方法</button>
      {open ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-label="新建方法">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold">新建方法体系</h2>
            <input className="input" placeholder="方法名称（如：锂板块四因子体系）" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="用途说明（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
            <textarea className="input min-h-[280px] font-mono text-xs" placeholder="方法正文（Markdown）。首个版本将以草稿保存，需在详情页明确采用。" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setOpen(false)} disabled={busy}>取消</button>
              <button
                type="button"
                className="btn-primary px-3 py-1.5 text-xs"
                disabled={busy || !name.trim() || !text.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await createMethod({ name: name.trim(), description: description.trim() || undefined, text });
                    setOpen(false);
                    setName("");
                    setDescription("");
                    setText("");
                    await onCreated(result.method.methodId);
                  } catch (e) {
                    onError(e instanceof WorkspaceRequestError ? e.message : "创建失败");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : null}保存草稿
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function MethodDetail({
  methodId,
  onBack,
  onNotice,
  onOpenAsset,
}: {
  methodId: string;
  onBack: () => void;
  onNotice: (message: string) => void;
  onOpenAsset: (assetId: string) => void;
}) {
  const [detail, setDetail] = useState<MethodDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [diffPair, setDiffPair] = useState<{ from: string; to: string } | null>(null);
  const [diffText, setDiffText] = useState<{ from: string | null; to: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getMethod(methodId);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [methodId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!diffPair) {
      setDiffText(null);
      return;
    }
    if (!diffPair.from || !diffPair.to) return;
    void diffMethod(methodId, diffPair.from, diffPair.to)
      .then((result) => setDiffText({ from: result.from?.text ?? null, to: result.to?.text ?? null }))
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Diff 加载失败");
        setDiffPair(null);
      });
  }, [diffPair, methodId]);

  if (loading && !detail) return <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载方法详情…</div>;
  if (!detail) return <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error || "方法不存在"}</div>;
  const { method, versions, taskUsage, content } = detail;

  const act = async (key: string, action: () => Promise<unknown>, doneMessage: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      onNotice(doneMessage);
      await load();
    } catch (e) {
      setError(e instanceof WorkspaceRequestError ? `${e.message}（${e.code}）` : "操作失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" className="btn-secondary px-2 py-1.5 text-xs" onClick={onBack}><ArrowLeft size={15} />返回</button>
          <h2 className="truncate text-base font-semibold">{method.name}</h2>
          <StatusBadge method={method} />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="btn-secondary px-2.5 py-1.5 text-xs"
            onClick={() => {
              setEditing(true);
              setEditText(content?.text ?? "");
            }}
          >
            <Pencil size={15} />编辑新版本
          </button>
          {method.pendingDraft ? (
            <button
              type="button"
              className="btn-primary px-2.5 py-1.5 text-xs"
              disabled={busy === "adopt"}
              onClick={() =>
                void act("adopt", () => adoptMethod(method.methodId, { versionId: method.pendingDraft!.versionId, mode: "adopt" }), `已采用 v${method.pendingDraft!.versionNumber}，后续默认运行将使用该版本`)
              }
            >
              {busy === "adopt" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}采用待确认版本 v{method.pendingDraft.versionNumber}
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="flex items-center justify-between border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button>
        </div>
      ) : null}
      {method.description ? <p className="text-xs text-[#5f6660]">{method.description}</p> : null}

      {editing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">编辑正文</h3>
            <span className="text-[11px] text-amber-700">保存后形成待确认草稿；在明确采用之前不影响任何运行。</span>
          </div>
          <textarea className="input min-h-[320px] font-mono text-xs" value={editText} onChange={(e) => setEditText(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setEditing(false)}>取消</button>
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              disabled={busy === "save" || !editText.trim()}
              onClick={() =>
                void act("save", async () => addMethodVersion(method.methodId, { text: editText }), "新草稿版本已保存，可在版本时间线中查看并采用").then(() => setEditing(false))
              }
            >
              {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : null}保存草稿版本
            </button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold">版本时间线</h3>
        <div className="flex flex-col divide-y divide-[#eceeeb]">
          {versions.length === 0 ? <p className="py-3 text-xs text-[#7a827c]">暂无正式版本。</p> : null}
          {versions.map((version) => {
            const isCurrent = version.versionId === method.currentVersionId;
            return (
              <div key={version.versionId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">v{version.versionNumber}</span>
                  <span className={version.status === "approved" ? "rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800" : version.status === "draft" ? "rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" : "rounded bg-[#eceae4] px-1.5 py-0.5 text-[#7a827c]"}>
                    {version.status === "approved" ? (isCurrent ? "当前采用" : "已批准") : version.status === "draft" ? "待确认" : version.status === "superseded" ? "已被替代" : version.status}
                  </span>
                  {version.adoptionConstraints.length > 0 ? <span className="rounded bg-[#f4efe2] px-1.5 py-0.5 text-[#8a6d3b]" title="该版本带采用约束">{version.adoptionConstraints.join(", ")}</span> : null}
                  <span className="text-[#7a827c]">{formatDate(version.createdAt)}</span>
                  {version.approvedAt ? <span className="text-[#7a827c]">批准于 {formatDate(version.approvedAt)}</span> : null}
                </div>
                <div className="flex items-center gap-1.5">
                  {versions.length > 1 ? (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-[11px]"
                      onClick={() => setDiffPair((prev) => selectDiffVersion(prev, version.versionId))}
                      title="选择两个版本进行对比"
                    >
                      <GitCompare size={13} />{diffPair?.to === version.versionId ? "对比(右)" : diffPair?.from === version.versionId ? "对比(左)" : "对比"}
                    </button>
                  ) : null}
                  {version.status === "superseded" && !isCurrent ? (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-[11px]"
                      disabled={busy === `readopt:${version.versionId}`}
                      onClick={() =>
                        void act(`readopt:${version.versionId}`, () => adoptMethod(method.methodId, { versionId: version.versionId, mode: "readopt" }), `已恢复采用 v${version.versionNumber}`)
                      }
                    >
                      <RotateCcw size={13} />恢复采用
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {diffPair ? (
          <div className="mt-3 rounded border border-[#dfe3df] bg-[#fafbfa] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold">版本对比{diffPair.from && diffPair.to ? `：左 v${versions.find((v) => v.versionId === diffPair.from)?.versionNumber ?? "?"} → 右 v${versions.find((v) => v.versionId === diffPair.to)?.versionNumber ?? "?"}` : "（请在时间线上选择两个版本）"}</span>
              <button type="button" className="rounded p-1 hover:bg-[#eceeeb]" onClick={() => setDiffPair(null)} aria-label="关闭对比"><X size={14} /></button>
            </div>
            {diffText ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <pre className="max-h-[360px] overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed">{diffText.from ?? "（无正文）"}</pre>
                <pre className="max-h-[360px] overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed">{diffText.to ?? "（无正文）"}</pre>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-[#7a827c]"><Loader2 size={14} className="animate-spin" />加载版本正文…</div>
            )}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">使用该方法的自动化（{taskUsage.length}）</h3>
          {taskUsage.length === 0 ? <p className="text-xs text-[#7a827c]">暂无自动化绑定该方法。任务将保持其固定版本，直到你明确改绑。</p> : (
            <ul className="flex flex-col gap-1.5">
              {taskUsage.map((usage) => (
                <li key={usage.taskId} className="flex items-center justify-between gap-2 text-xs">
                  <a className="truncate text-[#52705f] underline-offset-2 hover:underline" href={`/automations/${encodeURIComponent(usage.taskId)}`}>{usage.taskName || usage.taskId}</a>
                  <span className="shrink-0 text-[#7a827c]">{usage.pinnedVersionNumber ? `固定 v${usage.pinnedVersionNumber}` : "跟随当前版本"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">关联资料</h3>
          {method.assetId ? (
            <button type="button" className="text-xs text-[#52705f] underline-offset-2 hover:underline" onClick={() => onOpenAsset(method.assetId!)}>
              在我的文件中查看方法正文资产（版本链）
            </button>
          ) : (
            <p className="text-xs text-[#7a827c]">暂无关联资料。</p>
          )}
        </div>
      </div>
    </div>
  );
}
