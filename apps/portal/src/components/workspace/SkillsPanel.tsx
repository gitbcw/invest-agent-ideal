"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpCircle, Check, FlaskConical, Loader2, Package, Pencil, Plus, Power, PowerOff, RefreshCw, Trash2, X } from "lucide-react";
import type { CatalogSkillCardView, InstalledSkillCardView, SkillDetailView } from "@/lib/workspace-api";
import { WorkspaceRequestError, editSkill, enableSkill, getSkill, installSkill, listInstalledSkills, listSkillCatalog, setSkillStatus, uninstallSkill } from "./api";
import { useAppNavigate } from "@/lib/app-navigation";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

const PRESET_SKILL_NAMES: Record<string, string> = {
  "strategy-simulation": "量化策略模拟",
  "technical-analysis": "技术面分析",
  "risk-control": "仓位与风控",
  "macro-analysis": "宏观分析",
  "fundamental-analysis": "基本面分析",
  "candidate-screening": "候选筛选",
};

const PRESET_SKILL_SUMMARIES: Record<string, string> = {
  "strategy-simulation": "把可量化的策略规则按历史行情逐日回放，生成 HTML 模拟报告。",
  "technical-analysis": "帮助你分析趋势、均线、突破和量价变化。",
  "risk-control": "帮助你检查仓位、回撤和组合风险。",
  "macro-analysis": "帮助你理解政策、利率和流动性对投资的影响。",
  "fundamental-analysis": "帮助你分析公司的经营质量、估值和长期价值。",
  "candidate-screening": "帮助你发现候选标的并整理后续观察条件。",
};

function displaySkillName(skill: { slug: string; name: string }): string {
  return PRESET_SKILL_NAMES[skill.slug] || skill.name;
}

function shortSkillSummary(skill: InstalledSkillCardView): string {
  return PRESET_SKILL_SUMMARIES[skill.slug] || skill.description?.split("：").pop()?.split("。")[0] + "。" || "帮助你处理相关投资问题。";
}

const SKILL_TRIALS: Record<string, { when: string; impact: string; examples: string[] }> = {
  "strategy-simulation": {
    when: "你有可量化的买卖/仓位规则，想看它在历史区间逐日模拟的表现时。",
    impact: "只模拟能量化为条件和数值的规则，按日给出信号或模拟成交并输出 HTML 报告；主观或消息面判断不模拟。",
    examples: [
      "按我的策略（跌破止损线减仓、放量突破加仓）模拟前20个交易日，给我 HTML 报告。",
      "我的策略里哪些条件是可量化的？先把不能模拟的部分告诉我。",
      "从今天开始按这套量化规则每天模拟，每天存一份报告。",
    ],
  },
  "technical-analysis": {
    when: "你想判断趋势、均线、突破回踩或量价变化时。",
    impact: "会围绕价格、成交量和技术结构组织分析，不替代你的交易决定。",
    examples: ["请分析贵州茅台（600519）最近的趋势和关键支撑位，并标出数据时点。", "请判断贵州茅台（600519）最近一次突破更像有效突破还是假突破，并说明依据。", "结合宁德时代（300750）的均线和成交量，判断当前更适合观察哪些条件。"],
  },
  "risk-control": {
    when: "你想检查仓位、回撤、止损止盈或组合暴露时。",
    impact: "会优先指出风险边界和需要避免的操作，不直接替你下单。",
    examples: ["请检查我当前持仓的仓位和行业暴露风险，并标出需要补充的数据。", "如果贵州茅台（600519）继续下跌，我应该重点观察哪些风险触发条件？", "请检查我当前组合是否过度集中在白酒或消费行业，并说明判断依据。"],
  },
  "macro-analysis": {
    when: "你想了解政策、利率、汇率、流动性或大盘环境对投资的影响时。",
    impact: "会把宏观变化连接到行业和持仓影响，并标注仍需验证的部分。",
    examples: ["请分析最近一个可核验的利率变化可能怎样影响我的持仓，并区分事实与推断。", "请分析当前可核验的市场流动性变化对科技股的可能影响，并标出未知项。", "请梳理新能源汽车购置税政策对整车和电池行业的可能影响，并注明政策时点与来源。"],
  },
  "fundamental-analysis": {
    when: "你想分析公司的商业模式、财务质量、估值或竞争优势时。",
    impact: "会从公司经营和长期价值角度分析，不把一次结果当成买卖建议。",
    examples: ["请从基本面分析贵州茅台（600519）是否值得长期跟踪，并列出关键缺口。", "请分析宁德时代（300750）的盈利质量，包括现金流、应收和利润持续性。", "请比较贵州茅台（600519）与五粮液（000858）的商业模式和估值安全边际。"],
  },
  "candidate-screening": {
    when: "你想发现候选标的、做风险初筛或整理买入等待条件时。",
    impact: "会输出可跟踪的候选和验证条件，不直接荐股或自动交易。",
    examples: ["请从当前可核验数据中筛选 3 个值得继续跟踪的 A 股行业候选，并说明样本边界。", "请把贵州茅台（600519）、五粮液（000858）和宁德时代（300750）按风险与等待条件整理。", "请按‘盈利质量较稳定、估值不过高、趋势未明显破坏’对 A 股公司做初筛，并先说明数据缺口。"],
  },
};

function skillTrial(skill: InstalledSkillCardView) {
  return SKILL_TRIALS[skill.slug] || {
    when: "你提出与这项技能说明相关的问题时。",
    impact: "会按技能说明组织分析，具体资料和结果仍由任务与会话决定。",
    examples: ["请用这个技能帮我分析一个具体问题。", "这个技能适合怎样的问题？", "请给我一个使用这个技能的示例。"],
  };
}

export function SkillsPanel() {
  const appNavigate = useAppNavigate();
  const [installed, setInstalled] = useState<InstalledSkillCardView[]>([]);
  const [catalog, setCatalog] = useState<CatalogSkillCardView[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<InstalledSkillCardView | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inst, cat] = await Promise.all([listInstalledSkills(), listSkillCatalog()]);
      setInstalled(inst.items);
      setCatalog(cat.items);
      setCatalogLoaded(true);
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
      setError(e instanceof Error ? e.message : "加载技能目录失败");
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

  const installedIds = new Set(installed.map((item) => item.skillId));
  const availableCatalog = catalog.filter((item) => !installedIds.has(item.skillId));
  // 「待启用」分组：当前 scope 里尚未安装的用户私有技能（catalog 中 source=private 的未安装项）。
  const pendingEnable = availableCatalog.filter((item) => item.source === "private");
  // 2026-10-08 用户裁决：禁用只是排名靠后——启用的在前、禁用的在后，
  // 不单独分区（filter 拼接保持各自原有相对顺序，即稳定排序）；「已禁用」徽标保留。
  const sortedInstalled = [
    ...installed.filter((item) => item.status !== "disabled"),
    ...installed.filter((item) => item.status === "disabled"),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-[#7a827c]">这里展示助手当前具备的技能。打开一项技能，可以查看它能帮你做什么、什么时候会使用，以及当前是否生效。</p>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新
          </button>
          <button type="button" className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => appNavigate("/chat?new=1&guide=skill-create")}>
            <Plus size={15} />新建技能
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
      {selectedSkill ? (
        <SkillInfoDialog
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onToggleStatus={() => {
            const skill = selectedSkill;
            setSelectedSkill(null);
            void actOnSkill(skill, () => setSkillStatus(skill.skillId, skill.status === "disabled"), skill.status === "disabled" ? `已启用 ${skill.name}` : `已禁用 ${skill.name}`);
          }}
          onDelete={() => {
            const skill = selectedSkill;
            setSelectedSkill(null);
            void actOnSkill(skill, () => uninstallSkill(skill.skillId), `已删除 ${skill.name}`);
          }}
        />
      ) : null}

      {pendingEnable.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">待启用（{pendingEnable.length}）</h3>
            <p className="text-xs text-[#7a827c]">你保存的技能还没有在当前助手启用。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {pendingEnable.map((item) => (
              <div key={`${item.skillId}:${item.versionId}`} className="flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{item.name}</span>
                  <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-800">私有</span>
                </div>
                {item.description ? <p className="skill-preview line-clamp-2 text-xs text-[#59655c]">{item.description}</p> : null}
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn-primary px-2 py-1 text-[11px]"
                    disabled={busySkillId === item.skillId}
                    onClick={async () => {
                      setBusySkillId(item.skillId);
                      setError(null);
                      try {
                        await installSkill(item.skillId, { versionId: item.versionId });
                        setNotice(`已启用 ${item.name}`);
                        await refresh();
                      } catch (e) {
                        setError(e instanceof WorkspaceRequestError ? `${e.message}（${e.code}）` : "启用失败");
                      } finally {
                        setBusySkillId(null);
                      }
                    }}
                  >
                    {busySkillId === item.skillId ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}启用
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">助手当前的技能（{installed.length}）</h3>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载…</div>
        ) : installed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#dfe3df] bg-white px-6 py-8 text-center text-sm text-[#7a827c]">
            <p>当前助手还没有可展示的技能。</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {sortedInstalled.map((skill) => (
              <HoverDetailCard
                key={skill.installationId}
                hasDetail={Boolean(skill.description)}
                onClick={() => setSelectedSkill(skill)}
                detail={
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[#202123]">{displaySkillName(skill)}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${skill.status === "disabled" ? "bg-[#eceae4] text-[#7a827c]" : "bg-emerald-100 text-emerald-800"}`}>
                        {skill.status === "disabled" ? "已禁用" : "已启用"}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#3c443e]">{skill.description}</p>
                  </>
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Package size={15} className="shrink-0 text-[#52705f]" />
                    <span className="truncate text-sm font-semibold" title={displaySkillName(skill)}>{displaySkillName(skill)}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${skill.source === "release" ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800"}`}>
                      {skill.source === "release" ? "预置" : "私有"}
                    </span>
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${skill.status === "disabled" ? "bg-[#eceae4] text-[#7a827c]" : "bg-emerald-100 text-emerald-800"}`}>
                    {skill.status === "disabled" ? "已禁用" : "已启用"}
                  </span>
                </div>
                <div className="rounded-md bg-[#f7f9f7] px-3 py-2.5">
                  <p className="text-[11px] font-medium text-[#718078]">技能说明</p>
                  <p className="skill-preview mt-1 line-clamp-3 text-xs leading-5 text-[#59655c]">{skill.description || "暂时没有详细说明，打开详情查看当前状态。"}</p>
                </div>
                {/* 禁用/删除只在点开技能弹窗里操作（2026-10-08 用户裁决），卡片上只保留非破坏性的升级 */}
                {skill.isPrivateSkill && skill.availableUpgrade ? (
                  <div className="flex flex-wrap items-center gap-1.5">
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
                  </div>
                ) : null}
              </HoverDetailCard>
            ))}
          </div>
        )}
      </section>
      {catalogOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="找回技能">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">找回已删除的技能</h3>
                <p className="mt-1 text-xs text-[#7a827c]">找回后默认启用；系统基础技能不会出现在这里。</p>
              </div>
              <button type="button" className="btn-secondary p-1" aria-label="关闭" onClick={() => setCatalogOpen(false)}><X size={16} /></button>
            </div>
            {catalogLoading ? <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载目录…</div> : availableCatalog.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#dfe3df] px-6 py-8 text-center text-sm text-[#7a827c]">没有可找回的技能。</div>
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
                    {item.description ? <p className="skill-preview line-clamp-2 text-xs text-[#59655c]">{item.description}</p> : null}
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

/** 悬停详情卡：固定出现在所悬停卡片的黄金分割点（61.8%, 61.8%，卡片第四象限），不跟随鼠标。 */
function HoverDetailCard({ hasDetail, detail, children, onClick }: { hasDetail: boolean; detail: ReactNode; children: ReactNode; onClick?: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const measure = () => {
      const preview = cardRef.current?.querySelector<HTMLElement>(".skill-preview");
      const nextTruncated = Boolean(preview && preview.scrollHeight > preview.clientHeight + 1);
      setTruncated(nextTruncated);
      if (!nextTruncated) setOpen(false);
    };

    measure();
    const card = cardRef.current;
    if (!card) return undefined;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(card);
    return () => observer?.disconnect();
  }, [children]);

  return (
    <div
      ref={cardRef}
      className={`group relative flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4 transition-shadow ${onClick ? "cursor-pointer hover:border-[#a9c7ad] hover:shadow-md" : ""}`}
      onMouseEnter={() => hasDetail && truncated && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onClick?.();
      }}
    >
      {children}
      {hasDetail && truncated && open ? (
        <div
          role="tooltip"
          style={{ left: "61.8%", top: "61.8%" }}
          className="pointer-events-none absolute z-30 max-h-[70vh] min-h-[220px] w-56 overflow-y-auto rounded-xl border border-[#dfe3df] bg-white p-4 text-left opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100"
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function SkillInfoDialog({
  skill,
  onClose,
  onToggleStatus,
  onDelete,
}: {
  skill: InstalledSkillCardView;
  onClose: () => void;
  /** 点开后的管理操作（2026-10-08 用户裁决：禁用/删除只在弹窗里出现）。 */
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const appNavigate = useAppNavigate();
  const trial = skillTrial(skill);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`${displaySkillName(skill)}技能说明`}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-5 overflow-y-auto rounded-xl border border-[#d9e5db] bg-white p-5 shadow-xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{displaySkillName(skill)}</h2><span className={`rounded px-1.5 py-0.5 text-[11px] ${skill.status === "disabled" ? "bg-[#eceae4] text-[#7a827c]" : "bg-emerald-100 text-emerald-800"}`}>{skill.status === "disabled" ? "已禁用" : "已启用"}</span></div>
            <p className="mt-1 text-xs text-[#7a827c]">{skill.source === "release" ? "系统提供的技能" : "你保存的技能"}</p>
          </div>
          <button type="button" className="btn-secondary p-1.5" aria-label="关闭技能说明" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="text-sm leading-6 text-[#3c443e]">{shortSkillSummary(skill)}</p>
        <div className="border-t border-[#edf0ed] pt-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#304936]"><FlaskConical size={16} />试试看</div>
          <div className="mt-3 flex flex-col gap-2">
            {trial.examples.map((example) => <button key={example} type="button" className="rounded-lg border border-[#dce7dd] bg-white px-3 py-2 text-left text-xs leading-5 text-[#3c443e] transition hover:border-[#52705f] hover:bg-[#f7fbf7]" onClick={() => appNavigate(`/chat?new=1&guide=skill-try&auto=1&prompt=${encodeURIComponent(example)}`)}>{example}</button>)}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[#edf0ed] pt-3">
          <span className="text-[11px] text-[#8a938c]">当前版本 v{skill.versionNumber}</span>
          {skill.isPrivateSkill ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition hover:opacity-80 ${skill.status === "disabled" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}
                onClick={onToggleStatus}
              >
                {skill.status === "disabled" ? <Power size={13} /> : <PowerOff size={13} />}
                {skill.status === "disabled" ? "启用" : "禁用"}
              </button>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700 transition hover:opacity-80 disabled:opacity-50"
                disabled={skill.taskBindingCount > 0}
                title={skill.taskBindingCount > 0 ? `有 ${skill.taskBindingCount} 个任务引用此技能；请先调整任务依赖` : "删除当前助手的技能"}
                onClick={onDelete}
              >
                <Trash2 size={13} />删除
              </button>
            </div>
          ) : null}
        </div>
      </div>
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

  if (loading && !detail) return <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载技能说明…</div>;
  if (!detail) return <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error || "技能不存在"}</div>;
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
          <h2 className="truncate text-base font-semibold">{displaySkillName(skill)}</h2>
          {skill.installation ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">已启用</span> : <span className="rounded bg-[#eceae4] px-1.5 py-0.5 text-[11px] text-[#7a827c]">未启用</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => { setEditing(true); setEditText(content?.text ?? ""); }}><Pencil size={15} />调整技能说明</button>
          {skill.pendingDraft ? (
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs"
              disabled={busy === "enable"}
              onClick={() => void act("enable", () => enableSkill(skill.skillId, skill.pendingDraft!.versionId), `已启用 v${skill.pendingDraft!.versionNumber}`)}
            >
              {busy === "enable" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}确认并启用新说明
            </button>
          ) : null}
          {skill.installation ? (
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs text-red-700"
              disabled={busy === "uninstall" || skill.taskBindingCount > 0}
              title={skill.taskBindingCount > 0 ? `有 ${skill.taskBindingCount} 个任务引用此技能；请先调整任务依赖` : "删除当前助手的技能"}
              onClick={() => void act("uninstall", () => uninstallSkill(skill.skillId), "已删除；助手运行将不再使用该技能")}
            >
              {busy === "uninstall" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}删除
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary px-2.5 py-1.5 text-xs"
              disabled={busy === "install"}
              onClick={() => void act("install", () => installSkill(skill.skillId, skill.availableUpgrade ? { releaseId: skill.availableUpgrade.releaseId ?? undefined, versionId: skill.availableUpgrade.versionId } : {}), "已启用当前版本")}
            >
              {busy === "install" ? <Loader2 size={15} className="animate-spin" /> : null}启用
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

      <section className="rounded-xl border border-[#d9e5db] bg-[#f7fbf7] p-5">
        <h3 className="text-sm font-semibold text-[#304936]">这个技能能帮你做什么</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#3c443e]">{skill.description || "当前还没有补充说明。你可以在对话中告诉助手希望长期采用的做法，再由助手整理成技能草案。"}</p>
        <div className="mt-4 grid gap-3 border-t border-[#dce7dd] pt-4 sm:grid-cols-3">
          <div><p className="text-[11px] font-medium text-[#718078]">什么时候使用</p><p className="mt-1 text-xs leading-5 text-[#59655c]">助手会根据你的问题和任务场景自动判断。</p></div>
          <div><p className="text-[11px] font-medium text-[#718078]">当前状态</p><p className="mt-1 text-xs leading-5 text-[#59655c]">{skill.installation ? (skill.status === "disabled" ? "已禁用，不参与当前运行" : "已启用，可在适用场景中使用") : "未安装，不参与当前运行"}</p></div>
          <div><p className="text-[11px] font-medium text-[#718078]">运行影响</p><p className="mt-1 text-xs leading-5 text-[#59655c]">技能只提供处理规则；具体资料和结果仍由任务与会话决定。</p></div>
        </div>
      </section>

      {editing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[#dfe3df] bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">调整技能说明</h3>
            <span className="text-[11px] text-amber-700">保存后先进入待确认状态；确认启用后才会影响助手。</span>
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
              {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : null}保存待确认说明
            </button>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold">变更记录（{versions.length}）</h3>
        <div className="flex flex-col divide-y divide-[#eceeeb]">
          {versions.length === 0 ? <p className="py-3 text-xs text-[#7a827c]">暂无版本。</p> : null}
          {versions.map((version) => {
            const isCurrent = version.versionId === skill.currentVersionId;
            return (
              <div key={version.versionId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">第 {version.versionNumber} 次调整</span>
                  <span className={version.status === "approved" ? "rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800" : version.status === "draft" ? "rounded bg-amber-100 px-1.5 py-0.5 text-amber-800" : "rounded bg-[#eceae4] px-1.5 py-0.5 text-[#7a827c]"}>
                    {version.status === "approved" ? (isCurrent ? "当前生效" : "已确认") : version.status === "draft" ? "待确认" : "已被替代"}
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
          <h3 className="mb-2 text-sm font-semibold">使用范围（{installations.length}）</h3>
          {installations.length === 0 ? <p className="text-xs text-[#7a827c]">未安装。</p> : (
            <ul className="flex flex-col gap-1 text-xs">
              {installations.map((installation) => (
                <li key={installation.installationId} className="flex justify-between gap-2">
                  <span className="truncate">{installation.agentName}</span>
                    <span className="shrink-0 text-[#7a827c]">当前使用</span>
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
