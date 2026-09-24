"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpCircle, Check, Eye, Loader2, Package, Pencil, Plus, Power, PowerOff, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { CatalogSkillCardView, InstalledSkillCardView, SkillDetailView } from "@/lib/workspace-api";
import { WorkspaceRequestError, editSkill, enableSkill, getSkill, installSkill, listInstalledSkills, listSkillCatalog, setSkillStatus, uninstallSkill } from "./api";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

export function SkillsPanel() {
  const [installed, setInstalled] = useState<InstalledSkillCardView[]>([]);
  const [catalog, setCatalog] = useState<CatalogSkillCardView[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const inst = await listInstalledSkills();
      setInstalled(inst.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setError(null);
    try {
      const result = await listSkillCatalog();
      setCatalog(result.items);
      setCatalogLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载 Skill 目录失败");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const openCatalog = () => {
    setCatalogOpen(true);
    void loadCatalog();
  };

  const actOnSkill = async (skill: InstalledSkillCardView, action: () => Promise<unknown>, doneMessage: string) => {
    setBusySkillId(skill.skillId);
    setError(null);
    try {
      await action();
      setNotice(doneMessage);
      await refresh();
      if (catalogOpen && catalogLoaded) await loadCatalog();
    } catch (e) {
      setError(e instanceof WorkspaceRequestError ? `${e.message}（${e.code}）` : "操作失败");
    } finally {
      setBusySkillId(null);
    }
  };

  if (selectedId) {
    return (
      <SkillDetail
        skillId={selectedId}
        onBack={() => {
          setSelectedId(null);
          void refresh();
        }}
        onNotice={setNotice}
      />
    );
  }

  const installedIds = new Set(installed.map((item) => item.skillId));
  const availableCatalog = catalog.filter((item) => !installedIds.has(item.skillId));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[#7a827c]">已安装的 Skill 会在适用场景生效；停用会保留安装状态，之后可以重新启用。</p>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新
          </button>
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={openCatalog}>
            <Search size={15} />找回 Skill
          </button>
          <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => window.location.assign("/chat?new=1&guide=skill-create")}>
            <Plus size={15} />新建 Skill
          </button>
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

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">助手已安装的 Skills（{installed.length}）</h3>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载…</div>
        ) : installed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#dfe3df] bg-white px-6 py-8 text-center text-sm text-[#7a827c]">
            <p>当前助手没有已安装的可管理 Skill。</p>
            <button type="button" className="btn-secondary mt-3 px-2.5 py-1.5 text-xs" onClick={openCatalog}><Search size={14} />从目录找回</button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {installed.map((skill) => (
              <HoverDetailCard
                key={skill.installationId}
                hasDetail={Boolean(skill.description)}
                detail={
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[#202123]">{skill.name}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${skill.status === "disabled" ? "bg-[#eceae4] text-[#7a827c]" : "bg-emerald-100 text-emerald-800"}`}>
                        {skill.status === "disabled" ? "已停用" : "已启用"}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-[#8a938c]">{skill.slug}</p>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#3c443e]">{skill.description}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 border-t border-[#eef0ee] pt-2 text-[11px] text-[#7a827c]">
                      <span>v{skill.versionNumber}</span>
                      <span>{skill.source === "release" ? `来源：发布 ${skill.releaseVersion || skill.releaseId || "—"}` : "来源：私有"}</span>
                      <span>安装于 {formatDate(skill.installedAt)}</span>
                    </div>
                  </>
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Package size={15} className="shrink-0 text-[#52705f]" />
                    <span className="truncate text-sm font-semibold" title={skill.name}>{skill.name}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${skill.source === "release" ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800"}`}>
                      {skill.source === "release" ? "预置" : "私有"}
                    </span>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${skill.status === "disabled" ? "bg-[#eceae4] text-[#7a827c]" : "bg-emerald-100 text-emerald-800"}`}>
                    {skill.status === "disabled" ? "已停用" : "已启用"}
                  </span>
                </div>
                <p className="font-mono text-[11px] text-[#7a827c]">{skill.slug}</p>
                {skill.description ? <p className="line-clamp-2 text-xs text-[#59655c]">{skill.description}</p> : null}
                <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-[#7a827c]">
                  <span>v{skill.versionNumber}</span>
                  <span>{skill.source === "release" ? `来源：发布 ${skill.releaseVersion || skill.releaseId || "—"}` : "来源：私有"}</span>
                  <span>安装于 {formatDate(skill.installedAt)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {skill.isPrivateSkill ? (
                    <button type="button" className="btn-secondary px-2 py-1 text-[11px]" onClick={() => setSelectedId(skill.skillId)}>
                      <Eye size={13} />详情
                    </button>
                  ) : null}
                  {skill.availableUpgrade ? (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-[11px]"
                      disabled={busySkillId === skill.skillId}
                      onClick={async () => {
                        await actOnSkill(skill, () => installSkill(skill.skillId, { releaseId: skill.availableUpgrade!.releaseId ?? undefined, versionId: skill.availableUpgrade!.versionId }), `已升级 ${skill.name} 到 v${skill.availableUpgrade!.versionNumber}`);
                      }}
                    >
                      {busySkillId === skill.skillId ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpCircle size={13} />}升级到 v{skill.availableUpgrade.versionNumber}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-secondary px-2 py-1 text-[11px]"
                    disabled={busySkillId === skill.skillId}
                    onClick={() => void actOnSkill(skill, () => setSkillStatus(skill.skillId, skill.status === "disabled"), skill.status === "disabled" ? `已启用 ${skill.name}` : `已停用 ${skill.name}`)}
                  >
                    {busySkillId === skill.skillId ? <Loader2 size={13} className="animate-spin" /> : skill.status === "disabled" ? <Power size={13} /> : <PowerOff size={13} />}
                    {skill.status === "disabled" ? "启用" : "停用"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary px-2 py-1 text-[11px] text-red-700"
                    disabled={busySkillId === skill.skillId || skill.taskBindingCount > 0}
                    title={skill.taskBindingCount > 0 ? `有 ${skill.taskBindingCount} 个任务引用此 Skill；请先调整任务依赖` : "卸载当前助手的 Skill"}
                    onClick={() => void actOnSkill(skill, () => uninstallSkill(skill.skillId), `已卸载 ${skill.name}；可从目录找回`)}
                  >
                    <Trash2 size={13} />卸载
                  </button>
                </div>
              </HoverDetailCard>
            ))}
          </div>
        )}
      </section>
      {catalogOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="找回 Skill">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">找回已卸载的 Skill</h3>
                <p className="mt-1 text-xs text-[#7a827c]">安装后默认启用；系统基础能力不会出现在这里。</p>
              </div>
              <button type="button" className="btn-secondary p-1" aria-label="关闭" onClick={() => setCatalogOpen(false)}><X size={16} /></button>
            </div>
            {catalogLoading ? <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载目录…</div> : availableCatalog.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#dfe3df] px-6 py-8 text-center text-sm text-[#7a827c]">没有可找回的 Skill。</div>
            ) : (
              <div className="grid min-h-0 gap-3 overflow-y-auto sm:grid-cols-2">
                {availableCatalog.map((item) => (
                  <HoverDetailCard
                    key={`${item.skillId}:${item.versionId}`}
                    hasDetail={Boolean(item.description)}
                    detail={
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-[#202123]">{item.name}</span>
                          <span className="shrink-0 rounded bg-[#eceae4] px-1.5 py-0.5 text-[11px] text-[#59655c]">{item.source === "private" ? "私有" : "预置"}</span>
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-[#8a938c]">{item.slug}</p>
                        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#3c443e]">{item.description}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-x-3 border-t border-[#eef0ee] pt-2 text-[11px] text-[#7a827c]">
                          {item.releaseVersion ? <span>发布 {item.releaseVersion}</span> : null}
                          <span>{item.source === "private" ? "来源：私有" : "来源：系统发布"}</span>
                        </div>
                      </>
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-sm font-semibold break-words">{item.name}</span>
                      <span className="shrink-0 rounded bg-[#eceae4] px-1.5 py-0.5 text-[11px] text-[#59655c]">{item.source === "private" ? "私有" : "预置"}</span>
                    </div>
                    <p className="font-mono text-[11px] text-[#7a827c]">{item.slug}</p>
                    {item.description ? <p className="line-clamp-2 text-xs text-[#59655c]">{item.description}</p> : null}
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#7a827c]">
                      <span>{item.releaseVersion ? `v${item.releaseVersion}` : "可安装版本"}</span>
                      <button
                        type="button"
                        className="btn-primary px-2 py-1 text-[11px]"
                        disabled={busySkillId === item.skillId}
                        onClick={async () => {
                          setBusySkillId(item.skillId);
                          setError(null);
                          try {
                            await installSkill(item.skillId, { releaseId: item.releaseId ?? undefined, versionId: item.versionId });
                            setNotice(`已找回 ${item.name}，当前已启用`);
                            await refresh();
                            await loadCatalog();
                          } catch (e) {
                            setError(e instanceof WorkspaceRequestError ? `${e.message}（${e.code}）` : "安装失败");
                          } finally {
                            setBusySkillId(null);
                          }
                        }}
                      >
                        {busySkillId === item.skillId ? <Loader2 size={13} className="animate-spin" /> : <Package size={13} />}安装
                      </button>
                    </div>
                  </HoverDetailCard>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 悬停详情卡：出现在鼠标首次进入卡片的位置（而非固定边），靠近视口边缘时自动内翻。 */
function HoverDetailCard({ hasDetail, detail, children }: { hasDetail: boolean; detail: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  return (
    <div
      className="group relative flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4"
      onMouseEnter={(event) => {
        if (!hasDetail) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const cardWidth = 320;
        const cardHeight = 240; // 估算高度；内容超高由 max-h 滚动兜底
        const offset = 10;
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        let left = x + offset;
        let top = y + offset;
        if (rect.left + left + cardWidth > window.innerWidth - 8) left = x - cardWidth - offset;
        if (rect.top + top + cardHeight > window.innerHeight - 8) top = y - cardHeight - offset;
        setPos({ left: Math.max(left, 8 - rect.left), top: Math.max(top, 8 - rect.top) });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {hasDetail && pos ? (
        <div
          role="tooltip"
          style={{ left: pos.left, top: pos.top }}
          className="pointer-events-none absolute z-30 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-[#dfe3df] bg-white p-4 text-left opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100"
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function SkillDetail({ skillId, onBack, onNotice }: { skillId: string; onBack: () => void; onNotice: (message: string) => void }) {
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSkill(skillId);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) return <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载 Skill 详情…</div>;
  if (!detail) return <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error || "Skill 不存在"}</div>;
  const { skill, versions, installations, taskUsage, relatedMethodIds, content } = detail;

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
          <h2 className="truncate text-base font-semibold">{skill.name}</h2>
          <span className="font-mono text-[11px] text-[#7a827c]">{skill.slug}</span>
          {skill.installation ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">已安装 v{skill.installation.versionNumber}</span> : <span className="rounded bg-[#eceae4] px-1.5 py-0.5 text-[11px] text-[#7a827c]">未安装</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => { setEditing(true); setEditText(content?.text ?? ""); }}><Pencil size={15} />编辑新版本</button>
          {skill.pendingDraft ? (
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs"
              disabled={busy === "enable"}
              onClick={() => void act("enable", () => enableSkill(skill.skillId, skill.pendingDraft!.versionId), `已启用 v${skill.pendingDraft!.versionNumber}`)}
            >
              {busy === "enable" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}启用待确认版本 v{skill.pendingDraft.versionNumber}
            </button>
          ) : null}
          {skill.installation ? (
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs text-red-700"
              disabled={busy === "uninstall" || skill.taskBindingCount > 0}
              title={skill.taskBindingCount > 0 ? `有 ${skill.taskBindingCount} 个任务引用此 Skill；请先调整任务依赖` : "卸载当前助手的 Skill"}
              onClick={() => void act("uninstall", () => uninstallSkill(skill.skillId), "已卸载；助手运行将不再使用该 Skill")}
            >
              {busy === "uninstall" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}卸载
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary px-2.5 py-1.5 text-xs"
              disabled={busy === "install"}
              onClick={() => void act("install", () => installSkill(skill.skillId, skill.availableUpgrade ? { releaseId: skill.availableUpgrade.releaseId ?? undefined, versionId: skill.availableUpgrade.versionId } : {}), "已安装当前启用版本")}
            >
              {busy === "install" ? <Loader2 size={15} className="animate-spin" /> : null}安装
            </button>
          )}
        </div>
      </div>
      {error ? (
        <div className="flex items-center justify-between border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button>
        </div>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">编辑正文</h3>
            <span className="text-[11px] text-amber-700">保存后为待确认草稿；明确启用并安装后才影响助手。</span>
          </div>
          <textarea className="input min-h-[300px] font-mono text-xs" value={editText} onChange={(e) => setEditText(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setEditing(false)}>取消</button>
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              disabled={busy === "save" || !editText.trim()}
              onClick={() => void act("save", async () => editSkill(skill.skillId, { text: editText }), "新草稿版本已保存").then(() => setEditing(false))}
            >
              {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : null}保存草稿版本
            </button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold">版本（{versions.length}）</h3>
        <div className="flex flex-col divide-y divide-[#eceeeb]">
          {versions.length === 0 ? <p className="py-3 text-xs text-[#7a827c]">暂无版本。</p> : null}
          {versions.map((version) => {
            const isCurrent = version.versionId === skill.currentVersionId;
            return (
              <div key={version.versionId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">v{version.versionNumber}</span>
                  <span className={version.status === "approved" ? "rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800" : version.status === "draft" ? "rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" : "rounded bg-[#eceae4] px-1.5 py-0.5 text-[#7a827c]"}>
                    {version.status === "approved" ? (isCurrent ? "当前启用" : "已批准") : version.status === "draft" ? "待确认" : "已被替代"}
                  </span>
                  <span className="text-[#7a827c]">{formatDate(version.createdAt)}</span>
                </div>
                {version.status === "draft" ? (
                  <button type="button" className="btn-secondary px-2 py-1 text-[11px]" disabled={busy === `enable:${version.versionId}`} onClick={() => void act(`enable:${version.versionId}`, () => enableSkill(skill.skillId, version.versionId), `已启用 v${version.versionNumber}`)}>
                    <Check size={13} />启用
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">安装（{installations.length}）</h3>
          {installations.length === 0 ? <p className="text-xs text-[#7a827c]">未安装。</p> : (
            <ul className="flex flex-col gap-1 text-xs">
              {installations.map((installation) => (
                <li key={installation.installationId} className="flex justify-between gap-2">
                  <span className="truncate">{installation.agentName}</span>
                  <span className="shrink-0 text-[#7a827c]">v{installation.versionNumber}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">适用任务（{taskUsage.length}）</h3>
          {taskUsage.length === 0 ? <p className="text-xs text-[#7a827c]">暂无任务依赖。</p> : (
            <ul className="flex flex-col gap-1 text-xs">
              {taskUsage.map((usage) => (
                <li key={usage.taskId}><a className="truncate text-[#52705f] hover:underline" href={`/automations/${encodeURIComponent(usage.taskId)}`}>{usage.taskName || usage.taskId}</a></li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">关联方法（{relatedMethodIds.length}）</h3>
          {relatedMethodIds.length === 0 ? <p className="text-xs text-[#7a827c]">暂无关联方法。</p> : (
            <ul className="flex flex-col gap-1 text-xs">
              {relatedMethodIds.map((method) => (
                <li key={method.methodId}><span className="truncate">{method.name}</span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
