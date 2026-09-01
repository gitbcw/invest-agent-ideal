"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Building2,
  ChartNoAxesCombined,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  CircleAlert,
  Clock3,
  Copy,
  FileSpreadsheet,
  FilePlus2,
  Filter,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

import type {
  AutomationCreateRequest,
  AutomationDeliveryPolicy,
  AutomationListQuery,
  AutomationOutputPolicy,
  AutomationSchedule,
  AutomationTask,
  AutomationTaskRun,
  AutomationTaskStatus,
  AutomationRunsListRequest,
  UserAsset,
} from "@/lib/protocol";
import { createClientId } from "@/lib/client-id";
import {
  AUTOMATION_FILE_ACCEPT,
  AUTOMATION_INPUT_FILE_ACCEPT,
  AUTOMATION_INPUT_SUPPORTED_FILE_LABEL,
  AUTOMATION_SUPPORTED_FILE_LABEL,
  AUTOMATION_TIMEZONE,
  isSupportedAutomationFileName,
  isSupportedAutomationInputFileName,
} from "@/lib/automation-schemas";
import {
  AUTOMATION_TEMPLATES,
  findAutomationTemplate,
  type AutomationTemplate,
} from "@/lib/automation-templates";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { PatrolShell } from "@/components/patrol/PatrolShell";
import { useFilePanel } from "@/components/file-panel/FilePanelProvider";
import {
  activateAutomation,
  archiveAutomation,
  batchAutomationAction,
  continueAutomationInChat,
  createAutomation,
  fetchAutomation,
  fetchAutomationRun,
  fetchAutomationRuns,
  fetchAutomations,
  fileToAutomationAsset,
  pauseAutomation,
  runAutomationNow,
  updateAutomation,
  type AutomationApiError,
} from "./api";
import { archiveAsset, fileToAsset, listAssets, uploadAsset } from "../assets/api";

const WEEKDAYS = [
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [7, "周日"],
] as const;

type View = "tasks" | "runs" | "templates" | "patrol" | "new" | "task" | "run";
type WorkspaceView = Extract<View, "tasks" | "runs" | "templates" | "patrol">;
type TaskFilter = "all" | AutomationTaskStatus;
type AttachmentFileCategory = "all" | "document" | "spreadsheet" | "image";

const AUTOMATION_INPUT_FORMATS = new Set([
  "markdown",
  "html",
  "csv",
  "xlsx",
  "pdf",
  "png",
  "jpeg",
  "webp",
  "svg",
]);

type EditorState = {
  name: string;
  description: string;
  frequency: AutomationSchedule["frequency"];
  time: string;
  weekdays: number[];
  deliveryEnabled: boolean;
  deliveryMode: "wechat_summary" | "wechat_on_condition";
  file: File | null;
  selectedAsset: UserAsset | null;
  fileError: string | null;
  existingInputs: AutomationTask["revision"]["inputs"];
  existingOutput: AutomationOutputPolicy | undefined;
  existingTask?: AutomationTask;
};

function emptyEditor(): EditorState {
  return {
    name: "",
    description: "",
    frequency: "daily",
    time: "07:30",
    weekdays: [1],
    deliveryEnabled: false,
    deliveryMode: "wechat_summary",
    file: null,
    selectedAsset: null,
    fileError: null,
    existingInputs: [],
    existingOutput: { mode: "none" },
  };
}

export function AutomationWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = getView(pathname, searchParams.get("view"));
  const taskId = getId(pathname, "/automations/");
  const runId = getId(pathname, "/automations/runs/");
  const [error, setError] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [visitedWorkspaceViews, setVisitedWorkspaceViews] = useState<
    Set<WorkspaceView>
  >(() => new Set([isWorkspaceView(view) ? view : "tasks"]));

  useEffect(() => {
    if (!isWorkspaceView(view)) return;
    setVisitedWorkspaceViews((current) =>
      current.has(view) ? current : new Set([...current, view]),
    );
  }, [view]);

  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#263129]">
      <PortalSidebar active="automations" />
      <div className="min-w-0 flex-1">
        <AutomationHeader
          view={view}
          batchMode={batchMode}
          onToggleBatch={() => setBatchMode((value) => !value)}
        />
        {error ? (
          <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-6">
            <ErrorBanner
              message={error}
              onClose={() => setError(null)}
              onRetry={() => {
                setError(null);
                setRetryKey((value) => value + 1);
              }}
            />
          </div>
        ) : null}
        {visitedWorkspaceViews.has("tasks") ? (
          <div hidden={view !== "tasks"}>
            <TaskListView
              onError={setError}
              batchMode={batchMode}
              onToggleBatch={() => setBatchMode((value) => !value)}
              onExitBatch={() => setBatchMode(false)}
              retryKey={retryKey}
            />
          </div>
        ) : null}
        {visitedWorkspaceViews.has("runs") ? (
          <div hidden={view !== "runs"}>
            <RunListViewFiltered onError={setError} retryKey={retryKey} />
          </div>
        ) : null}
        {visitedWorkspaceViews.has("templates") ? (
          <div hidden={view !== "templates"}>
            <TemplatesView />
          </div>
        ) : null}
        {visitedWorkspaceViews.has("patrol") ? (
          <div hidden={view !== "patrol"} className="bg-[#f4f7f4]">
            <PatrolShell />
          </div>
        ) : null}
        {view === "new" ? <EditorView onError={setError} /> : null}
        {view === "task" && taskId ? (
          <TaskDetailView taskId={taskId} onError={setError} />
        ) : null}
        {view === "run" && runId ? (
          <RunDetailViewAccurate runId={runId} onError={setError} />
        ) : null}
        {view === "task" && !taskId ? (
          <NotFoundState onBack={() => router.push("/automations")} />
        ) : null}
        {view === "run" && !runId ? (
          <NotFoundState onBack={() => router.push("/automations?view=runs")} />
        ) : null}
      </div>
    </div>
  );
}

function AutomationHeader({
  view,
  batchMode,
  onToggleBatch,
}: {
  view: View;
  batchMode: boolean;
  onToggleBatch: () => void;
}) {
  const showSearch = view === "tasks" || view === "runs";
  const pathname = usePathname() || "/automations";
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get("query") || "";
  return (
    <header className="border-b border-[#e2e6e2] bg-white">
      <div className="mx-auto flex min-h-[64px] w-full max-w-[1440px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:flex-nowrap">
        {view === "templates" || view === "new" ? (
          <nav className="order-1 flex items-center gap-2 text-sm" aria-label="自动化面包屑">
            <Link href="/automations?view=tasks" className="font-medium text-[#304936] hover:text-[#527a5d]">自动化</Link>
            <span className="text-[#a0aaa2]">/</span>
            <span className="text-[#718078]">{view === "templates" ? "从模板添加" : "添加自动化任务"}</span>
          </nav>
        ) : (
          <nav
            className="order-1 flex shrink-0 items-center rounded-lg bg-[#f4f6f4] p-1 text-sm"
            aria-label="自动化任务导航"
          >
          <Link
            href="/automations?view=tasks"
            aria-current={
              view === "tasks" || view === "task" ? "page" : undefined
            }
            className={`rounded-md px-3 py-2 ${view === "tasks" || view === "task" ? "bg-white font-medium text-[#304936] shadow-sm" : "text-[#718078] hover:text-[#304936]"}`}
          >
            定时任务
          </Link>
          <Link
            href="/automations?view=runs"
            aria-current={
              view === "runs" || view === "run" ? "page" : undefined
            }
            className={`rounded-md px-3 py-2 ${view === "runs" || view === "run" ? "bg-white font-medium text-[#304936] shadow-sm" : "text-[#718078] hover:text-[#304936]"}`}
          >
            运行记录
          </Link>
          <Link
            href="/automations?view=patrol"
            aria-current={view === "patrol" ? "page" : undefined}
            className={`rounded-md px-3 py-2 ${view === "patrol" ? "bg-white font-medium text-[#304936] shadow-sm" : "text-[#718078] hover:text-[#304936]"}`}
          >
            规则巡检
          </Link>
          </nav>
        )}
        {showSearch ? (
          <div className="order-2 flex w-full items-center gap-2 lg:ml-auto lg:w-[250px]">
            <label className="relative block w-full">
              <span className="sr-only">
                {view === "runs" ? "搜索运行记录" : "搜索自动化任务"}
              </span>
              <Search
                className="pointer-events-none absolute left-3 top-2.5 text-[#9aa49c]"
                size={16}
              />
              <input
                className="input-base h-10 !pl-9"
                value={search}
                placeholder={
                  view === "runs" ? "搜索运行记录" : "搜索自动化任务"
                }
                onChange={(event) =>
                  replaceAutomationQuery(router, pathname, searchParams, {
                    query: event.target.value || null,
                  })
                }
              />
            </label>
          </div>
        ) : null}
        {view === "tasks" ? (
          <div className="order-3 flex w-full gap-2 lg:w-auto">
            <div className="hidden sm:block">
              <button
                type="button"
                className={`btn-secondary h-10 px-3 ${batchMode ? "border-[#71947a] bg-[#edf5ee] text-[#385d40]" : ""}`}
                onClick={onToggleBatch}
              >
                {batchMode ? <X size={16} /> : <Settings2 size={16} />}
                {batchMode ? "退出管理" : "批量管理"}
              </button>
            </div>
            <div className="hidden sm:block">
              <Link
                href="/automations?view=templates"
                className="btn-secondary h-10 px-3"
              >
                <FilePlus2 size={16} />
                模板示例
              </Link>
            </div>
            <Link
              href="/automations/new"
              className="btn-primary h-10 px-3 sm:px-4"
            >
              <Plus size={16} />
              添加自动化
            </Link>
          </div>
        ) : null}
        {view === "new" ? (
          <div className="order-3 ml-auto flex gap-2">
            <Link
              href="/automations?view=tasks"
              className="btn-secondary h-10 px-4"
            >
              取消
            </Link>
            <button
              type="button"
              className="btn-primary h-10 px-4"
              onClick={() =>
                document
                  .querySelector<HTMLFormElement>("main.max-w-3xl form")
                  ?.requestSubmit()
              }
            >
              保存
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function TaskListView({
  onError,
  batchMode,
  onToggleBatch,
  onExitBatch,
  retryKey,
}: {
  onError: (message: string) => void;
  batchMode: boolean;
  onToggleBatch: () => void;
  onExitBatch: () => void;
  retryKey: number;
}) {
  const pathname = usePathname() || "/automations";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!batchMode) setSelected([]);
  }, [batchMode]);

  const search = searchParams.get("query") || "";
  const rawStatus = searchParams.get("status") || "all";
  const filter: TaskFilter = [
    "all",
    "paused",
    "active",
    "needs_attention",
    "archived",
  ].includes(rawStatus)
    ? (rawStatus as TaskFilter)
    : "all";
  const frequencies = parseQueryList(searchParams.get("frequencies"));
  const deliveryModes = parseQueryList(searchParams.get("deliveryModes"));
  const includeArchived = searchParams.get("archived") === "1";

  const query = useMemo<AutomationListQuery>(
    () => ({
      query: search.trim() || undefined,
      statuses:
        filter === "all"
          ? includeArchived
            ? ["needs_attention", "active", "paused", "archived"]
            : undefined
          : [filter],
      frequencies: frequencies.length
        ? (frequencies as AutomationListQuery["frequencies"])
        : undefined,
      deliveryModes: deliveryModes.length
        ? (deliveryModes as AutomationListQuery["deliveryModes"])
        : undefined,
      limit: 50,
    }),
    [
      filter,
      includeArchived,
      search,
      frequencies.join(","),
      deliveryModes.join(","),
    ],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetchAutomations(query)
        .then((data) => {
          if (cancelled) return;
          setTasks(data.items);
          setCursor(data.nextCursor);
          setSelected([]);
        })
        .catch((cause) => {
          if (!cancelled) onError(readError(cause));
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            setHasLoaded(true);
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onError, query, retryKey]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const data = await fetchAutomations({ ...query, cursor });
      setTasks((current) => [...current, ...data.items]);
      setCursor(data.nextCursor);
    } catch (cause) {
      onError(readError(cause));
    } finally {
      setLoading(false);
    }
  }

  function updateFilters(changes: Record<string, string | null>) {
    replaceAutomationQuery(router, pathname, searchParams, changes);
  }

  function clearFilters() {
    replaceAutomationQuery(router, pathname, searchParams, {
      query: null,
      status: null,
      frequencies: null,
      deliveryModes: null,
      archived: null,
    });
    setFilterOpen(false);
  }

  function toggleSelected(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }
  function selectVisible() {
    setSelected(
      selected.length === tasks.length ? [] : tasks.map((task) => task.taskId),
    );
  }

  async function doBatch(action: "pause" | "activate" | "archive") {
    const items = tasks.filter((task) => selected.includes(task.taskId));
    if (!items.length) return;
    if (
      action === "archive" &&
      !window.confirm(
        `归档 ${items.length} 个任务？归档后任务停止执行且不可恢复启用（历史记录保留，可在筛选中勾选「显示已归档」查看）。`,
      )
    )
      return;
    if (action === "activate") {
      const withAssets = items.filter(
        (task) => task.revision.inputs?.length || task.sourceAsset,
      ).length;
      const withOutputUpdates = items.filter(
        (task) => task.revision.output?.mode === "update",
      ).length;
      const withPush = items.filter(
        (task) =>
          task.revision.delivery?.mode &&
          task.revision.delivery.mode !== "none",
      ).length;
      const frequenciesSummary = [
        ...new Set(
          items.map((task) =>
            formatFrequency(task.revision.schedule.frequency),
          ),
        ),
      ].join("、");
      if (
        !window.confirm(
          `确认启用 ${items.length} 个任务？执行频率包括 ${frequenciesSummary}；其中 ${withAssets} 个会读取资料，${withOutputUpdates} 个会更新已有产物，${withPush} 个会推送到微信。`,
        )
      )
        return;
    }
    try {
      const result = await batchAutomationAction({
        action,
        items: items.map((task) => ({
          taskId: task.taskId,
          expectedRevision: task.currentRevision,
        })),
        idempotencyKey: `portal:batch:${action}:${Date.now()}`,
      });
      const successful = result.results.filter(
        (item): item is Extract<typeof item, { ok: true }> => item.ok,
      );
      const failed = result.results.filter((item) => !item.ok);
      const successfulIds = new Set(successful.map((item) => item.taskId));
      setTasks((current) =>
        action === "archive" && !includeArchived
          ? current.filter((task) => !successfulIds.has(task.taskId))
          : current.map(
              (task) =>
                successful.find((item) => item.taskId === task.taskId)?.task ??
                task,
            ),
      );
      setSelected(failed.map((item) => item.taskId));
      const failureDetails = failed
        .slice(0, 3)
        .map(
          (item) =>
            `${items.find((task) => task.taskId === item.taskId)?.revision.name || "任务"}：${item.error.message}`,
        )
        .join("；");
      setBatchMessage(
        `已完成 ${successful.length} 项${failed.length ? `，${failed.length} 项未完成并保留勾选${failureDetails ? `（${failureDetails}）` : ""}` : ""}`,
      );
    } catch (cause) {
      onError(readError(cause));
    }
  }

  async function doSingle(
    action: "pause" | "activate" | "archive" | "run",
    task: AutomationTask,
  ) {
    if (
      action === "archive" &&
      !window.confirm("归档这个任务？归档后停止执行且不可恢复启用，历史运行记录会保留。")
    )
      return;
    try {
      if (action === "run") {
        setRunningTaskIds((current) => new Set(current).add(task.taskId));
        try {
          const result = await runAutomationNow(task.taskId);
          router.push(
            `/automations/runs/${encodeURIComponent(result.run.runId)}`,
          );
        } finally {
          setRunningTaskIds((current) => {
            const next = new Set(current);
            next.delete(task.taskId);
            return next;
          });
        }
        return;
      }
      const next =
        action === "pause"
          ? await pauseAutomation(task.taskId, task.currentRevision)
          : action === "activate"
            ? await activateAutomation(task.taskId, task.currentRevision)
            : await archiveAutomation(task.taskId, task.currentRevision);
      if (action === "archive" && !includeArchived)
        setTasks((current) =>
          current.filter((item) => item.taskId !== task.taskId),
        );
      else
        setTasks((current) =>
          current.map((item) => (item.taskId === next.taskId ? next : item)),
        );
    } catch (cause) {
      onError(readError(cause));
    }
    setMenuTaskId(null);
  }

  const activeFilterCount =
    (filter !== "all" ? 1 : 0) +
    frequencies.length +
    deliveryModes.length +
    (includeArchived ? 1 : 0);
  return (
    <main
      className={`mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:py-7 ${batchMode && selected.length ? "pb-28" : ""}`}
    >
      <div className="mb-4 flex justify-end">
        <div className="relative sm:hidden">
          <button
            type="button"
            className="btn-secondary h-10 px-3"
            aria-label="更多任务操作"
            aria-expanded={mobileActionsOpen}
            onClick={() => setMobileActionsOpen((value) => !value)}
          >
            <MoreHorizontal size={16} />
            更多
          </button>
          {mobileActionsOpen ? (
            <div className="absolute right-0 top-12 z-20 w-36 rounded-xl border border-[#dfe6df] bg-white p-1.5 text-sm shadow-lg">
              <Link
                href="/automations?view=templates"
                className="block rounded-lg px-3 py-2 hover:bg-[#f1f5f1]"
                onClick={() => setMobileActionsOpen(false)}
              >
                模板示例
              </Link>
              <button
                type="button"
                className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[#f1f5f1]"
                onClick={() => {
                  onToggleBatch();
                  setMobileActionsOpen(false);
                }}
              >
                {batchMode ? "退出管理" : "批量管理"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm ${filter === "all" ? "bg-[#2e4834] text-white" : "bg-white text-[#69766e] ring-1 ring-[#e0e6e1]"}`}
          onClick={() => updateFilters({ status: null })}
        >
          全部 <span className="text-xs opacity-70">{tasks.length}</span>
        </button>
        {(
          [
            ["needs_attention", "需要处理"],
            ["active", "执行中"],
            ["paused", "已暂停"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={`inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm ${filter === value ? "bg-[#2e4834] text-white" : "bg-white text-[#69766e] ring-1 ring-[#e0e6e1]"}`}
            onClick={() => updateFilters({ status: value })}
          >
            {label}
          </button>
        ))}
        <div className="relative ml-auto">
          <button
            type="button"
            className={`btn-secondary h-10 px-3 ${filterOpen ? "bg-[#f1f6f1]" : ""}`}
            onClick={() => setFilterOpen((value) => !value)}
            aria-expanded={filterOpen}
          >
            <Filter size={15} />
            筛选
            {activeFilterCount ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#dcebdd] px-1 text-[11px] text-[#3e6447]">
                {activeFilterCount}
              </span>
            ) : null}
            <ChevronDown size={14} />
          </button>
          {filterOpen ? (
            <div className="absolute right-0 top-12 z-20 w-72 rounded-xl border border-[#dfe6df] bg-white p-3 shadow-lg">
              <label className="block text-sm">
                <span className="block font-medium">执行频率</span>
                <select
                  className="input-base mt-1 h-9 w-full text-sm"
                  value={frequencies[0] || ""}
                  onChange={(event) =>
                    updateFilters({ frequencies: event.target.value || null })
                  }
                >
                  <option value="">全部频率</option>
                  <option value="daily">每天</option>
                  <option value="trading_days">交易日</option>
                  <option value="weekly">每周指定日期</option>
                </select>
              </label>
              <label className="mt-3 block text-sm">
                <span className="block font-medium">结果投递</span>
                <select
                  className="input-base mt-1 h-9 w-full text-sm"
                  value={deliveryModes[0] || ""}
                  onChange={(event) =>
                    updateFilters({ deliveryModes: event.target.value || null })
                  }
                >
                  <option value="">全部投递方式</option>
                  <option value="none">不推送</option>
                  <option value="wechat_summary">推送到微信</option>
                  <option value="wechat_on_condition">满足条件时推送</option>
                </select>
              </label>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[#52705f]"
                  checked={includeArchived}
                  onChange={(event) =>
                    updateFilters({
                      archived: event.target.checked ? "1" : null,
                    })
                  }
                />
                <span>
                  <span className="block font-medium">显示已归档</span>
                  <span className="mt-0.5 block text-xs text-[#879188]">
                    归档任务默认隐藏，避免干扰日常处理。
                  </span>
                </span>
              </label>
              <button
                type="button"
                className="mt-3 w-full rounded-lg bg-[#f4f7f4] px-3 py-2 text-left text-xs text-[#5e6c62] hover:bg-[#edf3ed]"
                onClick={clearFilters}
              >
                清除筛选
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {batchMessage ? (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-[#cfe1d1] bg-[#f0f7f1] px-3 py-2.5 text-sm text-[#45624b]">
          <span>{batchMessage}</span>
          <button
            type="button"
            className="rounded p-1 hover:bg-white"
            aria-label="关闭提示"
            onClick={() => setBatchMessage(null)}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
      {batchMode ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[#dfe8e0] bg-[#f8fbf8] px-3 py-2.5 text-sm text-[#53645a]">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              aria-label="全选当前结果"
              className="h-4 w-4 accent-[#52705f]"
              checked={tasks.length > 0 && selected.length === tasks.length}
              onChange={selectVisible}
            />
            全选当前结果
          </label>
          <span className="text-xs text-[#829087]">
            仅选择当前已加载且符合筛选的任务
          </span>
        </div>
      ) : null}
      <div className="relative overflow-visible border-y border-[#e1e6e2] bg-white">
        <div className="hidden grid-cols-[minmax(260px,1.7fr)_minmax(140px,1fr)_minmax(150px,1fr)_minmax(130px,1fr)_150px_164px] gap-4 border-b border-[#edf0ed] bg-[#fbfcfb] px-5 py-3 text-xs font-medium text-[#879188] lg:grid">
          <div className="flex items-center gap-2">任务名称 / 说明</div>
          <div>执行规则</div>
          <div>最近一次</div>
          <div>下次执行</div>
          <div>状态</div>
          <div className="text-right">操作</div>
        </div>
        {loading && !hasLoaded ? (
          <div className="space-y-2 p-4">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : tasks.length ? (
          <div>
            {tasks.map((task) => (
              <TaskRow
                key={task.taskId}
                task={task}
                batchMode={batchMode}
                selected={selected.includes(task.taskId)}
                menuOpen={menuTaskId === task.taskId}
                isRunning={runningTaskIds.has(task.taskId)}
                onSelect={() => toggleSelected(task.taskId)}
                onMenu={() => setMenuTaskId(menuTaskId === task.taskId ? null : task.taskId)}
                onAction={(action) => void doSingle(action, task)}
              />
            ))}
          </div>
        ) : (
          <TaskEmpty
            searched={Boolean(
              search ||
              filter !== "all" ||
              frequencies.length ||
              deliveryModes.length ||
              includeArchived,
            )}
            onClear={clearFilters}
          />
        )}
      </div>
      {cursor ? (
        <div className="flex justify-center py-5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : null}
            加载更多
          </button>
        </div>
      ) : null}
      {batchMode && selected.length ? (
        <BatchBar
          count={selected.length}
          onAction={(action) => void doBatch(action)}
          onExit={() => {
            onExitBatch();
            setSelected([]);
          }}
        />
      ) : null}
    </main>
  );
}

function TaskRow({
  task,
  batchMode,
  selected,
  menuOpen,
  isRunning,
  onSelect,
  onMenu,
  onAction,
}: {
  task: AutomationTask;
  batchMode: boolean;
  selected: boolean;
  menuOpen: boolean;
  isRunning: boolean;
  onSelect: () => void;
  onMenu: () => void;
  onAction: (action: "pause" | "activate" | "archive" | "run") => void;
}) {
  const status = statusMeta(task.status);
  const latest = task.latestRun;
  const hasRunningRun = isRunning || latest?.status === "running";
  const nextExecution =
    task.status === "active" && task.nextRunAt
      ? formatRelative(task.nextRunAt)
      : task.status === "paused"
        ? "已暂停"
        : task.status === "archived"
          ? "已归档"
          : "处理后安排";
  const nextExecutionTitle =
    task.status === "active" && task.nextRunAt
      ? formatDate(task.nextRunAt)
      : undefined;
  const latestClass =
    latest?.status === "failed" ? "text-[#a4544a]" : "text-[#66736a]";
  const latestSummary = latest
    ? `${latest.status === "succeeded" ? "已完成" : latest.status === "failed" ? "失败" : runStatusLabel(latest.status)} · ${formatRelative(latest.finishedAt || task.updatedAt)}`
    : "尚未运行";
  return (
    <div
      className={`relative grid gap-3 border-b border-[#edf0ed] px-4 py-4 last:border-b-0 sm:px-5 lg:grid-cols-[minmax(260px,1.7fr)_minmax(140px,1fr)_minmax(150px,1fr)_minmax(130px,1fr)_150px_164px] lg:items-center lg:gap-4 ${selected ? "bg-[#f4f8f4]" : "hover:bg-[#fcfdfc]"}`}
    >
      <div className="min-w-0 pr-32 lg:hidden">
        <div className="flex min-w-0 items-start gap-3">
          {batchMode ? (
            <label className="mt-1 shrink-0">
              <span className="sr-only">选择 {task.revision.name}</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#52705f]"
                checked={selected}
                onChange={onSelect}
              />
            </label>
          ) : null}
          <Link
            href={`/automations/${encodeURIComponent(task.taskId)}`}
            className="min-w-0 flex-1"
          >
            <span className="flex min-w-0 items-start gap-2">
              <span
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: status.dot }}
              />
              <strong className="line-clamp-2 text-sm font-semibold leading-5 text-[#314038]">
                {task.revision.name}
              </strong>
            </span>
            <span className="mt-1 block line-clamp-1 text-xs leading-5 text-[#7d887f]">
              {task.revision.description ||
                task.revision.instruction ||
                "暂无说明"}
            </span>
          </Link>
          <TaskStatusControl
            task={task}
            onToggle={() => onAction(task.status === "active" ? "pause" : "activate")}
          />
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-xs">
          <span
            className={`min-w-0 leading-5 ${latestClass}`}
            title={latest?.finishedAt ?? undefined}
          >
            {formatSchedule(task.revision.schedule)} · {latestSummary}
          </span>
          <span
            className="shrink-0 whitespace-nowrap leading-5 text-[#66736a]"
            title={nextExecutionTitle}
          >
            下次 {nextExecution}
          </span>
        </div>
      </div>
      <div className="hidden lg:contents">
        <div className="flex min-w-0 items-start gap-3">
          {batchMode ? (
            <label className="mt-1 shrink-0">
              <span className="sr-only">选择 {task.revision.name}</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#52705f]"
                checked={selected}
                onChange={onSelect}
              />
            </label>
          ) : null}
          <Link
            href={`/automations/${encodeURIComponent(task.taskId)}`}
            className="min-w-0 flex-1"
          >
            <span className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: status.dot }}
              />
              <strong className="truncate text-sm font-semibold text-[#314038]">
                {task.revision.name}
              </strong>
            </span>
            <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[#7d887f]">
              {task.revision.description ||
                task.revision.instruction ||
                "暂无说明"}
            </span>
          </Link>
        </div>
        <div className="text-xs text-[#66736a]">
          {formatSchedule(task.revision.schedule)}
        </div>
        <div className={`text-xs ${latestClass}`}>
          <span title={latest?.finishedAt ?? undefined}>{latestSummary}</span>
        </div>
        <div className="text-xs text-[#66736a]" title={nextExecutionTitle}>
          {nextExecution}
        </div>
        <TaskStatusControl
          task={task}
          onToggle={() => onAction(task.status === "active" ? "pause" : "activate")}
        />
      </div>
      <div className="absolute right-3 top-3 flex items-center gap-1 lg:static lg:justify-self-end">
        {task.status !== "archived" ? (
          <span className="group relative inline-flex">
            <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#59675e] hover:bg-[#eef3ee] disabled:cursor-not-allowed disabled:text-[#a4ada6]" aria-label={hasRunningRun ? "运行中" : "测试运行"} disabled={hasRunningRun} onClick={() => onAction("run")}>
              {hasRunningRun ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} strokeWidth={1.8} />}
            </button>
            <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 whitespace-nowrap rounded-md bg-[#202421] px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100">
              {hasRunningRun ? "运行中" : "测试运行"}
            </span>
          </span>
        ) : null}
        <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#7b877e] hover:bg-[#eef3ee]" aria-label={`打开 ${task.revision.name} 的更多操作`} title="更多操作" onClick={onMenu}>
          <MoreHorizontal size={17} />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-10 z-20 w-36 rounded-xl border border-[#dfe6df] bg-white p-1.5 text-sm shadow-lg">
            {task.status === "archived" ? <Link href={`/automations/new?copy=${encodeURIComponent(task.taskId)}`} className="block rounded-lg px-3 py-2 hover:bg-[#f1f5f1]">复制为新建任务</Link> : null}
            {task.status !== "archived" ? <Link href={`/automations/new?edit=${encodeURIComponent(task.taskId)}`} className="block rounded-lg px-3 py-2 hover:bg-[#f1f5f1]">编辑任务</Link> : null}
            {task.status !== "archived" ? <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[#f1f5f1]" onClick={() => onAction(task.status === "active" ? "pause" : "activate")}>{task.status === "active" ? "暂停执行" : "启用执行"}</button> : null}
            {task.status !== "archived" ? <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-[#a04c42] hover:bg-[#fff5f3]" onClick={() => onAction("archive")}>归档任务</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TaskStatusControl({
  task,
  onToggle,
}: {
  task: AutomationTask;
  onToggle: () => void;
}) {
  if (task.status !== "active" && task.status !== "paused") {
    return <StatusBadge status={task.status} />;
  }
  const active = task.status === "active";
  const label = active ? "已启用" : "已暂停";
  const action = active ? "暂停定时执行" : "启用定时执行";
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs text-[#66736a]">{label}</span>
      <span className="group relative inline-flex">
        <button
          type="button"
          role="switch"
          aria-checked={active}
          aria-label={action}
          className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${active ? "bg-[#52705f]" : "bg-[#cbd4cc]"}`}
          onClick={onToggle}
        >
          <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${active ? "translate-x-5" : "translate-x-0"}`} />
        </button>
        <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-[#202421] px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100">
          {action}
        </span>
      </span>
    </div>
  );
}

function BatchBar({
  count,
  onAction,
  onExit,
}: {
  count: number;
  onAction: (action: "pause" | "activate" | "archive") => void;
  onExit: () => void;
}) {
  return (
    <div className="fixed inset-x-3 bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-[#d5e1d6] bg-white/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_10px_30px_rgba(41,64,46,0.16)] backdrop-blur sm:inset-x-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2">
      <span className="mr-1 text-sm font-medium text-[#43594a]">
        已选 {count} 项
      </span>
      <button
        type="button"
        className="btn-secondary h-10 px-3"
        onClick={() => onAction("pause")}
      >
        <Pause size={14} />
        暂停
      </button>
      <button
        type="button"
        className="btn-secondary h-10 px-3"
        onClick={() => onAction("activate")}
      >
        <Play size={14} />
        启用
      </button>
      <button
        type="button"
        className="btn-secondary h-10 px-3 text-[#9a4d43]"
        onClick={() => onAction("archive")}
      >
        <Archive size={14} />
        归档
      </button>
      <button type="button" className="btn-ghost h-10 px-2" onClick={onExit}>
        退出
      </button>
    </div>
  );
}

function TaskEmpty({
  searched,
  onClear,
}: {
  searched: boolean;
  onClear: () => void;
}) {
  if (searched)
    return (
      <div className="px-6 py-20 text-center">
        <Search size={30} className="mx-auto text-[#a1aca3]" />
        <h3 className="mt-3 font-medium">没有找到匹配的任务</h3>
        <p className="mt-1 text-sm text-[#879188]">
          试试换个关键词，或清除筛选条件。
        </p>
        <button type="button" className="btn-secondary mt-5" onClick={onClear}>
          清除搜索和筛选
        </button>
      </div>
    );
  return (
    <div className="px-6 py-20 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#eaf3eb] text-[#527a5d]">
        <Sparkles size={25} />
      </div>
      <h3 className="mt-4 text-lg font-semibold">还没有自动化任务</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#78857b]">
        点击右上角“添加自动化”，配置触发时间与工作内容；需要处理文件时，可在任务说明下添加附件。
      </p>
      <Link
        href="/automations?view=templates"
        className="mt-5 inline-flex text-sm text-[#6b806f] hover:text-[#365d41] hover:underline sm:hidden"
      >
        查看任务模板示例
      </Link>
    </div>
  );
}

function RunRow({ run }: { run: AutomationTaskRun }) {
  const meta = runStatus(run.status, run.attempt);
  return (
    <Link
      href={`/automations/runs/${encodeURIComponent(run.runId)}`}
      className="grid gap-2 border-b border-[#edf0ed] px-4 py-3.5 last:border-b-0 hover:bg-[#fbfcfb] sm:grid-cols-[minmax(220px,1.3fr)_130px_minmax(220px,2fr)_180px] sm:items-center"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
        <span className="min-w-0">
          <strong className="block truncate text-sm font-medium text-[#35443a]">
            {run.taskName || "自动化任务"}
          </strong>
          <span className="mt-0.5 block text-xs text-[#8a958c]">
            第 {run.attempt ?? 1} 次尝试 ·{" "}
            {run.origin === "manual" ? "手动运行" : "计划运行"}
          </span>
        </span>
      </div>
      <StatusRunBadge status={run.status} attempt={run.attempt} />
      <div className="min-w-0">
        <p
          className={`truncate text-sm ${run.status === "failed" ? "text-[#a4544a]" : "text-[#657269]"}`}
        >
          {run.errorMessage || run.resultSummary || "暂无摘要"}
        </p>
        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-[#829087]">
          {run.outputAssetId ? (
            <span className="rounded bg-[#f0f5f0] px-1.5 py-0.5">文件变更</span>
          ) : null}
          {run.deliveryStatus && run.deliveryStatus !== "not_requested" ? (
            <span className="rounded bg-[#f5f5f2] px-1.5 py-0.5">
              微信：{deliveryStatusLabel(run.deliveryStatus)}
            </span>
          ) : null}
        </div>
      </div>
      <span
        className="text-xs text-[#879188] sm:text-right"
        title={run.finishedAt || run.createdAt}
      >
        {formatDate(run.finishedAt || run.createdAt)}
        <ChevronRight size={14} className="ml-1 inline" />
      </span>
    </Link>
  );
}

function RunListViewFiltered({
  onError,
  retryKey,
}: {
  onError: (message: string) => void;
  retryKey: number;
}) {
  const pathname = usePathname() || "/automations/runs";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [runs, setRuns] = useState<AutomationTaskRun[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const search = searchParams.get("query") || "";
  const statuses = parseQueryList(searchParams.get("statuses"));
  const origins = parseQueryList(searchParams.get("origins"));
  const deliveryStatuses = parseQueryList(searchParams.get("deliveryStatuses"));
  const hasOutputParam = searchParams.get("hasOutput") || "";
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  const query = useMemo<AutomationRunsListRequest>(
    () => ({
      query: search.trim() || undefined,
      statuses: statuses.length
        ? (statuses as AutomationRunsListRequest["statuses"])
        : undefined,
      origins: origins.length
        ? (origins as AutomationRunsListRequest["origins"])
        : undefined,
      deliveryStatuses: deliveryStatuses.length ? deliveryStatuses : undefined,
      hasOutput:
        hasOutputParam === "yes"
          ? true
          : hasOutputParam === "no"
            ? false
            : undefined,
      from: startDateForQuery(from),
      to: endDateForQuery(to),
      limit: 50,
    }),
    [
      search,
      statuses.join(","),
      origins.join(","),
      deliveryStatuses.join(","),
      hasOutputParam,
      from,
      to,
    ],
  );
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetchAutomationRuns(query)
        .then((data) => {
          if (!cancelled) {
            setRuns(data.items);
            setCursor(data.nextCursor);
          }
        })
        .catch((cause) => {
          if (!cancelled) onError(readError(cause));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onError, query, retryKey]);
  const groups = useMemo(() => groupRunsByDate(runs), [runs]);
  const activeFilterCount =
    statuses.length +
    origins.length +
    deliveryStatuses.length +
    (hasOutputParam ? 1 : 0) +
    (from ? 1 : 0) +
    (to ? 1 : 0);
  const noResultsWithFilters = Boolean(search || activeFilterCount);
  function updateFilters(changes: Record<string, string | null>) {
    replaceAutomationQuery(router, pathname, searchParams, changes);
  }
  function clearFilters() {
    replaceAutomationQuery(router, pathname, searchParams, {
      query: null,
      statuses: null,
      origins: null,
      deliveryStatuses: null,
      hasOutput: null,
      from: null,
      to: null,
    });
    setFilterOpen(false);
  }
  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const data = await fetchAutomationRuns({ ...query, cursor });
      setRuns((current) => [...current, ...data.items]);
      setCursor(data.nextCursor);
    } catch (cause) {
      onError(readError(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-5 sm:px-6 lg:py-7">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            运行记录
          </h2>
          <p className="mt-1 text-sm text-[#768178]">
            查看所有任务的执行结果、失败原因和投递状态。
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            className={`btn-secondary h-10 px-3 ${filterOpen ? "bg-[#f1f6f1]" : ""}`}
            onClick={() => setFilterOpen((value) => !value)}
            aria-expanded={filterOpen}
          >
            <Filter size={15} />
            筛选
            {activeFilterCount ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#dcebdd] px-1 text-[11px] text-[#3e6447]">
                {activeFilterCount}
              </span>
            ) : null}
            <ChevronDown size={14} />
          </button>
          {filterOpen ? (
            <div className="absolute right-0 top-12 z-20 w-80 rounded-xl border border-[#dfe6df] bg-white p-3 shadow-lg">
              <label className="block text-sm">
                <span className="block font-medium">运行状态</span>
                <select
                  className="input-base mt-1 h-9 w-full text-sm"
                  value={statuses[0] || ""}
                  onChange={(event) =>
                    updateFilters({ statuses: event.target.value || null })
                  }
                >
                  <option value="">全部状态</option>
                  <option value="running">运行中</option>
                  <option value="succeeded">成功</option>
                  <option value="failed">失败</option>
                  <option value="skipped">已跳过</option>
                  <option value="cancelled">已取消</option>
                </select>
              </label>
              <label className="mt-3 block text-sm">
                <span className="block font-medium">触发来源</span>
                <select
                  className="input-base mt-1 h-9 w-full text-sm"
                  value={origins[0] || ""}
                  onChange={(event) =>
                    updateFilters({ origins: event.target.value || null })
                  }
                >
                  <option value="">全部来源</option>
                  <option value="scheduled">计划运行</option>
                  <option value="manual">手动运行</option>
                </select>
              </label>
              <label className="mt-3 block text-sm">
                <span className="block font-medium">微信投递</span>
                <select
                  className="input-base mt-1 h-9 w-full text-sm"
                  value={deliveryStatuses[0] || ""}
                  onChange={(event) =>
                    updateFilters({
                      deliveryStatuses: event.target.value || null,
                    })
                  }
                >
                  <option value="">全部投递状态</option>
                  <option value="pending">等待投递</option>
                  <option value="sent">已发送</option>
                  <option value="suppressed">按条件未发送</option>
                  <option value="failed">投递失败</option>
                  <option value="not_requested">未请求</option>
                </select>
              </label>
              <label className="mt-3 block text-sm">
                <span className="block font-medium">文件变更</span>
                <select
                  className="input-base mt-1 h-9 w-full text-sm"
                  value={hasOutputParam}
                  onChange={(event) =>
                    updateFilters({ hasOutput: event.target.value || null })
                  }
                >
                  <option value="">全部</option>
                  <option value="yes">有文件变更</option>
                  <option value="no">没有文件变更</option>
                </select>
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-sm">
                  <span className="block font-medium">开始日期</span>
                  <input
                    type="date"
                    className="input-base mt-1 h-9 w-full text-sm"
                    value={from}
                    onChange={(event) =>
                      updateFilters({ from: event.target.value || null })
                    }
                  />
                </label>
                <label className="text-sm">
                  <span className="block font-medium">结束日期</span>
                  <input
                    type="date"
                    className="input-base mt-1 h-9 w-full text-sm"
                    value={to}
                    onChange={(event) =>
                      updateFilters({ to: event.target.value || null })
                    }
                  />
                </label>
              </div>
              <button
                type="button"
                className="mt-3 w-full rounded-lg bg-[#f4f7f4] px-3 py-2 text-left text-xs text-[#5e6c62] hover:bg-[#edf3ed]"
                onClick={clearFilters}
              >
                清除搜索和筛选
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="border-y border-[#e1e6e2] bg-white">
        {loading && !runs.length ? (
          <div className="space-y-2 p-4">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : runs.length ? (
          <div className="p-3 sm:p-5">
            {groups.map((group) => (
              <section key={group.key} className="mb-6 last:mb-0">
                <h3 className="mb-2 px-2 text-sm font-semibold text-[#5d6b61]">
                  {group.label}
                </h3>
                <div className="overflow-hidden rounded-lg border border-[#edf0ed]">
                  {group.runs.map((run) => (
                    <RunRow key={run.runId} run={run} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="px-6 py-20 text-center">
            <Clock3 size={32} className="mx-auto text-[#a2aca4]" />
            <h3 className="mt-3 font-medium">
              {noResultsWithFilters
                ? "没有找到匹配的运行记录"
                : "还没有运行记录"}
            </h3>
            <p className="mt-1 text-sm text-[#879188]">
              {noResultsWithFilters
                ? "试试换个关键词，或清除筛选条件。"
                : "任务执行后，结果会按日期出现在这里。"}
            </p>
            {noResultsWithFilters ? (
              <button
                type="button"
                className="btn-secondary mt-5"
                onClick={clearFilters}
              >
                清除搜索和筛选
              </button>
            ) : (
              <Link
                href="/automations"
                className="btn-secondary mt-5 inline-flex"
              >
                返回任务列表
              </Link>
            )}
          </div>
        )}
      </div>
      {cursor ? (
        <div className="flex justify-center py-5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            加载更多
          </button>
        </div>
      ) : null}
    </main>
  );
}

function TemplatesView() {
  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-5 sm:px-6 lg:py-8">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AUTOMATION_TEMPLATES.map((template) => (
          <TemplateCard key={template.templateId} template={template} />
        ))}
      </div>
    </main>
  );
}
function TemplateCard({ template }: { template: AutomationTemplate }) {
  const category =
    template.category === "information"
      ? "信息跟踪"
      : template.category === "review"
        ? "复盘整理"
        : "文件处理";
  const Icon =
    template.templateId === "daily-market-information"
      ? Bell
      : template.templateId === "industry-major-dynamics"
        ? Search
        : template.templateId === "portfolio-company-announcements"
          ? Building2
          : template.templateId === "weekly-watchlist-review"
            ? ClipboardCheck
            : template.templateId === "update-investment-tracker"
              ? ChartNoAxesCombined
              : FileSpreadsheet;
  return (
    <Link
      href={`/automations/new?template=${encodeURIComponent(template.templateId)}`}
      className="group flex min-h-[180px] flex-col rounded-2xl border border-[#e1e7e2] bg-white p-5 transition hover:-translate-y-0.5 hover:border-[#b7ceb9] hover:shadow-[0_8px_24px_rgba(44,70,49,0.08)]"
    >
      <div className="flex items-start justify-between">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f3f7f3] text-[#527a5d]"
          aria-hidden="true"
        >
          <Icon size={20} strokeWidth={1.7} />
        </span>
        <span className="rounded-full bg-[#eff5ef] px-2.5 py-1 text-xs text-[#5a745f]">
          {category}
        </span>
      </div>
      <h3 className="mt-4 text-base font-semibold text-[#304138]">
        {template.name}
      </h3>
      <p className="mt-2 text-sm leading-6 text-[#78857b]">
        {template.summary}
      </p>
    </Link>
  );
}

function EditorView({ onError }: { onError: (message: string) => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState<{ template?: string; edit?: string; copy?: string }>({});
  const [state, setState] = useState<EditorState>(() => emptyEditor());
  const [loading, setLoading] = useState(Boolean(getQuery("edit") || getQuery("copy")));
  const [saving, setSaving] = useState(false);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [myFiles, setMyFiles] = useState<UserAsset[]>([]);
  const [myFilesLoading, setMyFilesLoading] = useState(false);
  const [myFilesError, setMyFilesError] = useState<string | null>(null);
  const [myFilesSearch, setMyFilesSearch] = useState("");
  const [myFilesCategory, setMyFilesCategory] =
    useState<AttachmentFileCategory>("all");
  const deferredMyFilesSearch = useDeferredValue(myFilesSearch);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const template = findAutomationTemplate(query.template);
  const editing = Boolean(query.edit);
  const copying = Boolean(query.copy);
  const legacyTask = Boolean(
    state.existingTask?.sourceAsset &&
    !state.existingTask.revision.inputs?.length,
  );
  const requiresUpdateAsset = Boolean(
    template?.requirements.includes("update_asset"),
  );
  const allowedAssetFormats = useMemo(
    () =>
      legacyTask ? new Set(["csv", "xlsx"]) : AUTOMATION_INPUT_FORMATS,
    [legacyTask],
  );
  const inputFileAccept = legacyTask
    ? AUTOMATION_FILE_ACCEPT
    : AUTOMATION_INPUT_FILE_ACCEPT;
  const inputFileLabel = legacyTask
    ? AUTOMATION_SUPPORTED_FILE_LABEL
    : AUTOMATION_INPUT_SUPPORTED_FILE_LABEL;

  useEffect(() => {
    if (!attachmentPickerOpen) return;
    let cancelled = false;
    setMyFilesLoading(true);
    setMyFilesError(null);
    listAssets({
      status: "active",
      search: deferredMyFilesSearch.trim() || undefined,
      limit: 200,
    })
      .then((result) => {
        if (cancelled) return;
        setMyFiles(
          result.items.filter(
            (asset) =>
              Boolean(asset.currentVersionId) &&
              Boolean(
                asset.currentVersion?.format &&
                  allowedAssetFormats.has(asset.currentVersion.format),
              ),
          ),
        );
      })
      .catch((cause) => {
        if (!cancelled)
          setMyFilesError(
            cause instanceof Error ? cause.message : "我的文件暂时无法加载",
          );
      })
      .finally(() => {
        if (!cancelled) setMyFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowedAssetFormats, attachmentPickerOpen, deferredMyFilesSearch]);

  useEffect(
    () =>
      setQuery({
        template: getQuery("template") || undefined,
        edit: getQuery("edit") || undefined,
        copy: getQuery("copy") || undefined,
      }),
    [pathname],
  );
  useEffect(() => {
    let cancelled = false;
    const loadId = query.edit || query.copy;
    if (loadId) {
      fetchAutomation(loadId)
        .then((task) => {
          if (!cancelled) {
            setState(
              query.copy
                ? {
                    ...editorFromTask(task),
                    existingTask: undefined,
                    name: `${task.revision.name}（副本）`,
                  }
                : editorFromTask(task),
            );
            setLoading(false);
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            onError(readError(cause));
            setLoading(false);
          }
        });
    } else {
      const next = emptyEditor();
      if (template) applyTemplate(next, template);
      setState(next);
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [onError, query.copy, query.edit, query.template, template]);

  function patch(next: Partial<EditorState>) {
    setState((current) => ({ ...current, ...next }));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!state.name.trim()) {
      onError("请填写任务名称");
      return;
    }
    if (!state.description.trim()) {
      onError("请描述希望助手完成的事情");
      return;
    }
    if (state.fileError) {
      onError(state.fileError);
      return;
    }
    if (state.frequency === "weekly" && !state.weekdays.length) {
      onError("每周任务至少选择一天");
      return;
    }
    const needsInputAsset =
      template?.requirements.includes("input_asset") ||
      template?.requirements.includes("update_asset");
    if (
      needsInputAsset &&
      !state.file &&
      !state.selectedAsset &&
      !state.existingInputs?.length
    ) {
      onError("请在任务说明下添加需要处理的文件");
      return;
    }
    setSaving(true);
    let uploadedAsset: { assetId: string } | undefined;
    let persisted = false;
    try {
      const schedule: AutomationSchedule = {
        frequency: state.frequency,
        time: state.time,
        timezone: AUTOMATION_TIMEZONE,
        ...(state.frequency === "weekly" ? { weekdays: state.weekdays } : {}),
      };
      let inputs = state.existingInputs ?? [];
      let sourceAsset: AutomationCreateRequest["sourceAsset"];
      if (state.file) {
        if (legacyTask) sourceAsset = await fileToAutomationAsset(state.file);
        else {
          const file = await fileToAsset(state.file);
          const asset = await uploadAsset({
            ...file,
            name: state.file.name,
            idempotencyKey: `portal:automation-input:${createClientId()}`,
          });
          uploadedAsset = asset;
          inputs = [{ assetId: asset.assetId, role: "input", versionPolicy: "latest" }];
        }
      } else if (state.selectedAsset) {
        inputs = [
          {
            assetId: state.selectedAsset.assetId,
            role: "input",
            versionPolicy: "latest",
          },
        ];
      }
      const output: AutomationOutputPolicy = legacyTask
        ? (state.existingOutput ?? { mode: "none" as const })
        : { mode: "agent" };
      const delivery: AutomationDeliveryPolicy = !state.deliveryEnabled
        ? { mode: "none" }
        : state.deliveryMode === "wechat_on_condition"
          ? { mode: "wechat_on_condition", conditionVersion: 1 }
          : { mode: "wechat_summary" };
      const payload = legacyTask
        ? {
            name: state.name.trim(),
            description: state.description.trim(),
            schedule,
            ...(sourceAsset ? { sourceAsset } : {}),
          }
        : {
            name: state.name.trim(),
            description: state.description.trim(),
            schedule,
            instruction: state.description.trim(),
            inputs,
            output,
            delivery,
            ...(sourceAsset ? { sourceAsset } : {}),
          };
      if (state.existingTask)
        await updateAutomation(state.existingTask.taskId, {
          ...payload,
          expectedRevision: state.existingTask.currentRevision,
        });
      else await createAutomation(payload);
      persisted = true;
      router.push("/automations?view=tasks");
    } catch (cause) {
      if (uploadedAsset && !persisted)
        await archiveAsset(uploadedAsset.assetId).catch(() => undefined);
      onError(readError(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <Skeleton />
      </main>
    );
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 lg:py-8">
      <Link
        href={
          editing || copying
            ? `/automations/${encodeURIComponent(query.edit || query.copy || "")}`
            : "/automations"
        }
        className="inline-flex items-center gap-1 text-sm text-[#6f7d73] hover:text-[#36543d]"
      >
        <ArrowLeft size={15} />
        返回
      </Link>
      <div className="mt-5 rounded-2xl border border-[#e0e7e1] bg-white p-5 shadow-[0_2px_6px_rgba(41,61,45,0.03)] sm:p-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[#527a5d]">
              <Sparkles size={17} />
              <span className="text-sm font-medium">
                {editing ? "编辑任务" : copying ? "复制为新建任务" : "新建自动化任务"}
              </span>
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              {editing
                ? state.name || "编辑自动化任务"
                : copying
                  ? state.name || "复制自动化任务"
                  : "让助手按时帮你做一件事"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#77847a]">
              保存后会先保持暂停。确认一次结果符合预期，再开启定时执行。
            </p>
            {template ? (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#f0f6f0] px-3 py-1.5 text-xs text-[#54705a]">
                基于：{template.name}
              </p>
            ) : null}
          </div>
        </div>
        <form className="mt-8 space-y-8" onSubmit={submit}>
          <FormSection
            number="01"
            title="基本信息"
            hint="用一句话告诉助手要完成什么。"
          >
            <label className="block">
              <span className="text-sm font-medium">任务名称</span>
              <input
                className="input-base mt-2 h-11"
                value={state.name}
                onChange={(event) => patch({ name: event.target.value })}
                maxLength={200}
                placeholder="例如：每周整理我的研究资料"
                required
              />
            </label>
            <label className="mt-4 block">
              <span className="text-sm font-medium">任务说明</span>
              <textarea
                className="input-base mt-2 min-h-36 resize-y leading-6"
                value={state.description}
                onChange={(event) => patch({ description: event.target.value })}
                maxLength={12000}
                placeholder="描述要处理什么、关注哪些规则，以及你希望看到什么结果。"
                required
              />
              <span className="mt-1.5 block text-xs text-[#8a958c]">
                如果需要处理文件，直接在下面添加附件；不需要文件就只写说明。
              </span>
            </label>
            <div className="mt-4">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept={inputFileAccept}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  const supported = !file
                    ? true
                    : legacyTask
                      ? isSupportedAutomationFileName(file.name)
                      : isSupportedAutomationInputFileName(file.name);
                  if (!supported) {
                    patch({
                      file: null,
                      fileError: `暂不支持该文件类型。当前仅支持 ${inputFileLabel} 文件。`,
                    });
                    event.currentTarget.value = "";
                    return;
                  }
                  patch({ file, selectedAsset: null, fileError: null });
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary border-dashed"
                  onClick={() => setAttachmentPickerOpen(true)}
                >
                  <Paperclip size={16} />
                  添加附件
                </button>
                {state.file ? (
                  <span className="inline-flex max-w-full items-center gap-2 rounded-lg bg-[#f0f6f1] px-3 py-2 text-sm text-[#4d6854]">
                    <Paperclip size={14} />
                    <span className="max-w-[280px] truncate">
                      {state.file.name}
                    </span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-white"
                      aria-label="移除附件"
                      onClick={() =>
                        patch({
                          file: null,
                          selectedAsset: null,
                          fileError: null,
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  </span>
                ) : state.selectedAsset ? (
                  <span className="inline-flex max-w-full items-center gap-2 rounded-lg bg-[#f0f6f1] px-3 py-2 text-sm text-[#4d6854]">
                    <FolderOpen size={14} />
                    <span className="max-w-[280px] truncate">
                      {state.selectedAsset.name || state.selectedAsset.currentVersion?.fileName}
                    </span>
                    <span className="text-xs text-[#7d8b80]">我的文件</span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-white"
                      aria-label="移除附件"
                      onClick={() => patch({ selectedAsset: null, fileError: null })}
                    >
                      <X size={14} />
                    </button>
                  </span>
                ) : state.existingTask?.sourceAsset ? (
                  <span className="inline-flex max-w-full items-center gap-2 rounded-lg bg-[#f0f6f1] px-3 py-2 text-sm text-[#4d6854]">
                    <Paperclip size={14} />
                    <span className="max-w-[280px] truncate">
                      当前附件：{state.existingTask.sourceAsset.fileName}
                    </span>
                  </span>
                ) : state.existingInputs?.length ? (
                  <span className="inline-flex items-center gap-2 rounded-lg bg-[#f0f6f1] px-3 py-2 text-sm text-[#4d6854]">
                    <Paperclip size={14} />
                    已附加文件
                  </span>
                ) : null}
              </div>
              {state.fileError ? (
                <p className="mt-2 text-xs text-red-600">{state.fileError}</p>
              ) : (
                <p className="mt-2 text-xs text-[#8a958c]">
                  支持 {inputFileLabel}
                  ，文件会安全保存在“我的文件”中。
                </p>
              )}
            </div>
          </FormSection>
          <FormSection
            number="02"
            title="执行时间"
            hint="全部时间均按北京时间执行。"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="text-sm font-medium">执行频率</span>
                <select
                  className="input-base mt-2 h-11"
                  value={state.frequency}
                  onChange={(event) =>
                    patch({
                      frequency: event.target.value as EditorState["frequency"],
                    })
                  }
                >
                  <option value="daily">每天</option>
                  <option value="trading_days">交易日</option>
                  <option value="weekly">每周指定日期</option>
                </select>
              </label>
              <label>
                <span className="text-sm font-medium">执行时间</span>
                <input
                  className="input-base mt-2 h-11"
                  type="time"
                  value={state.time}
                  onChange={(event) => patch({ time: event.target.value })}
                  required
                />
              </label>
            </div>
            {state.frequency === "weekly" ? (
              <div className="mt-4">
                <span className="text-sm font-medium">每周执行日</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WEEKDAYS.map(([value, label]) => (
                    <label
                      key={value}
                      className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${state.weekdays.includes(value) ? "border-[#91b498] bg-[#edf6ef] text-[#365d41]" : "border-[#dce4dd] text-[#707d73]"}`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={state.weekdays.includes(value)}
                        onChange={() =>
                          patch({
                            weekdays: state.weekdays.includes(value)
                              ? state.weekdays.filter((day) => day !== value)
                              : [...state.weekdays, value].sort(),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="mt-4 text-xs text-[#8a958c]">
              任务创建后不会自动开始，确认结果后可在详情页启用。
            </p>
          </FormSection>
          <FormSection
            number="03"
            title="结果投递"
            hint="需要时，把执行结果摘要推送到已绑定的微信。"
          >
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-[#dce7dd] bg-[#f7fbf7] p-4">
              <span className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-[#527a5d]">
                  <Send size={16} />
                </span>
                <span>
                  <span className="block text-sm font-medium">
                    执行结果推送到微信
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-[#7b887e]">
                    开启后，任务完成时会把结果摘要发送到已绑定的微信。
                  </span>
                </span>
              </span>
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#52705f]"
                checked={state.deliveryEnabled}
                onChange={(event) =>
                  patch({ deliveryEnabled: event.target.checked })
                }
              />
            </label>
          </FormSection>
          <div className="flex flex-wrap justify-end gap-2 border-t border-[#edf0ed] pt-5">
            <Link
              href={
                editing || copying
                  ? `/automations/${encodeURIComponent(query.edit || query.copy || "")}`
                  : "/automations"
              }
              className="btn-secondary"
            >
              取消
            </Link>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Check size={16} />
              )}
              {editing ? "保存修改" : "创建任务"}
            </button>
          </div>
        </form>
      </div>
      {attachmentPickerOpen ? (
        <AttachmentPickerDialog
          files={myFiles}
          loading={myFilesLoading}
          error={myFilesError}
          search={myFilesSearch}
          category={myFilesCategory}
          allowedFormats={allowedAssetFormats}
          allowMyFiles={!legacyTask}
          onSearchChange={setMyFilesSearch}
          onCategoryChange={setMyFilesCategory}
          onClose={() => setAttachmentPickerOpen(false)}
          onUpload={() => {
            setAttachmentPickerOpen(false);
            window.setTimeout(() => fileInputRef.current?.click(), 0);
          }}
          onSelect={(asset) => {
            patch({ file: null, selectedAsset: asset, fileError: null });
            setAttachmentPickerOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function AttachmentPickerDialog({
  files,
  loading,
  error,
  search,
  category,
  allowedFormats,
  allowMyFiles,
  onSearchChange,
  onCategoryChange,
  onClose,
  onUpload,
  onSelect,
}: {
  files: UserAsset[];
  loading: boolean;
  error: string | null;
  search: string;
  category: AttachmentFileCategory;
  allowedFormats: Set<string>;
  allowMyFiles: boolean;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: AttachmentFileCategory) => void;
  onClose: () => void;
  onUpload: () => void;
  onSelect: (asset: UserAsset) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialogInteractions<HTMLDivElement>(onClose, closeButtonRef);
  const visibleFiles = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return files.filter((asset) => {
      const format = asset.currentVersion?.format;
      if (!format || !allowedFormats.has(format)) return false;
      if (category !== "all" && assetFileCategory(format) !== category)
        return false;
      return !keyword ||
        [asset.name, asset.currentVersion?.fileName]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(keyword));
    });
  }, [allowedFormats, category, files, search]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/25 p-3 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-picker-title"
        className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl sm:p-7"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="attachment-picker-title" className="text-lg font-semibold">
              添加附件
            </h2>
            <p className="mt-1 text-xs text-[#7a827c]">
              {allowMyFiles
                ? "从本地上传，或复用“我的文件”中的已有文件。"
                : "此旧版任务暂仅支持从本地上传表格文件。"}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="rounded-md p-1.5 hover:bg-[#f1f5f1]"
            onClick={onClose}
            aria-label="关闭附件选择"
          >
            <X size={17} />
          </button>
        </div>
        <button
          type="button"
          className="mt-5 flex w-full items-center gap-3 rounded-xl border border-dashed border-[#becabf] bg-[#fbfcfb] px-4 py-3 text-left hover:bg-[#f4f8f4]"
          onClick={onUpload}
        >
          <Upload size={18} className="text-[#527a5d]" />
          <span>
            <span className="block text-sm font-medium">从本地上传</span>
            <span className="mt-0.5 block text-xs text-[#7a827c]">
              选择电脑中的兼容文件
            </span>
          </span>
        </button>
        {allowMyFiles ? (
          <div className="mt-5 border-t border-[#edf1ed] pt-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FolderOpen size={16} className="text-[#527a5d]" />
              从我的文件选择
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label className="relative block min-w-0 flex-1">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#849086]"
                />
                <input
                  className="input-base h-9 w-full !pl-10 text-sm"
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="搜索文件名"
                  aria-label="搜索我的文件"
                />
              </label>
              <div className="flex gap-1 overflow-x-auto">
                {([
                  ["all", "全部"],
                  ["document", "文档"],
                  ["spreadsheet", "表格"],
                  ["image", "图片"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs ${
                      category === value
                        ? "bg-[#e8f1e9] text-[#41684a]"
                        : "text-[#6f7d73] hover:bg-[#f3f7f3]"
                    }`}
                    onClick={() => onCategoryChange(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {loading ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-[#7a827c]">
                <Loader2 size={14} className="animate-spin" />
                正在加载我的文件
              </div>
            ) : error ? (
              <p className="mt-3 text-xs text-red-600">{error}</p>
            ) : visibleFiles.length ? (
              <div className="mt-3 max-h-72 divide-y divide-[#edf1ed] overflow-y-auto rounded-lg border border-[#edf1ed]">
                {visibleFiles.map((asset) => (
                  <button
                    key={asset.assetId}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[#f3f7f3]"
                    onClick={() => onSelect(asset)}
                  >
                    <FileSpreadsheet size={16} className="shrink-0 text-[#527a5d]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-[#304138]">
                        {asset.name || asset.currentVersion?.fileName}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-[#8a958c]">
                        <span className="truncate">{asset.currentVersion?.fileName}</span>
                        <span className="shrink-0">{formatAutomationInput(asset.currentVersion?.format)}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-[#7a827c]">
                {search || category !== "all"
                  ? "没有匹配的文件。"
                  : "“我的文件”中还没有可用于自动化的文件。"}
              </p>
            )}
          </div>
        ) : null}
        <div className="mt-6 flex justify-end">
          <button type="button" className="btn-secondary px-4 py-2" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function assetFileCategory(format?: string): Exclude<AttachmentFileCategory, "all"> {
  if (format === "csv" || format === "xlsx") return "spreadsheet";
  if (["png", "jpeg", "webp", "svg"].includes(format || ""))
    return "image";
  return "document";
}

function formatAutomationInput(format?: string): string {
  const labels: Record<string, string> = {
    markdown: "Markdown",
    html: "HTML",
    csv: "CSV",
    xlsx: "Excel",
    pdf: "PDF",
    png: "PNG",
    jpeg: "JPEG",
    webp: "WebP",
    svg: "SVG",
  };
  return labels[format || ""] || "文件";
}

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function useDialogInteractions<T extends HTMLElement>(
  onClose: () => void,
  initialFocusRef: RefObject<HTMLElement | null>,
) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          DIALOG_FOCUSABLE_SELECTOR,
        ),
      ).filter((element) => element.offsetParent !== null);
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
    window.setTimeout(() => initialFocusRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [initialFocusRef]);
  return dialogRef;
}

function FormSection({
  children,
}: {
  children: React.ReactNode;
  number?: string;
  title?: string;
  hint?: string;
}) {
  return <section>{children}</section>;
}

function TaskDetailView({
  taskId,
  onError,
}: {
  taskId: string;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [task, setTask] = useState<AutomationTask | null>(null);
  const [runs, setRuns] = useState<AutomationTaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchAutomation(taskId),
      fetchAutomationRuns({ taskId, limit: 20 }),
    ])
      .then(([next, history]) => {
        if (!cancelled) {
          setTask(next);
          setRuns(history.items);
        }
      })
      .catch((cause) => {
        if (!cancelled) onError(readError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, taskId]);
  if (loading)
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <Skeleton />
        <div className="mt-3">
          <Skeleton />
        </div>
      </main>
    );
  if (!task)
    return <NotFoundState onBack={() => router.push("/automations")} />;
  const hasRunningRun = runs.some((run) => run.status === "running");
  const runDisabled = busy !== null || hasRunningRun;
  async function toggle() {
    setBusy("status");
    try {
      const next =
        task!.status === "active"
          ? await pauseAutomation(task!.taskId, task!.currentRevision)
          : await activateAutomation(task!.taskId, task!.currentRevision);
      setTask(next);
    } catch (cause) {
      onError(readError(cause));
    } finally {
      setBusy(null);
    }
  }
  async function runNow() {
    setBusy("run");
    try {
      const result = await runAutomationNow(task!.taskId);
      setTask(result.task);
      router.push(`/automations/runs/${encodeURIComponent(result.run.runId)}`);
    } catch (cause) {
      onError(readError(cause));
    } finally {
      setBusy(null);
    }
  }
  async function archive() {
    if (!window.confirm("归档这个任务？归档后停止执行且不可恢复启用，历史记录会保留。")) return;
    setBusy("archive");
    try {
      const next = await archiveAutomation(task!.taskId, task!.currentRevision);
      setTask(next);
    } catch (cause) {
      onError(readError(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 lg:py-8">
      <Link
        href="/automations"
        className="inline-flex items-center gap-1 text-sm text-[#6f7d73] hover:text-[#36543d]"
      >
        <ArrowLeft size={15} />
        返回任务列表
      </Link>
      <div className="mt-5 rounded-2xl border border-[#e0e7e1] bg-white p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <StatusBadge status={task.status} />
              <span className="text-xs text-[#8a958c]">
                版本 {task.currentRevision}
              </span>
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">
              {task.revision.name}
            </h2>
            <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm leading-6 text-[#708076]">
              {task.revision.description ||
                task.revision.instruction ||
                "暂无任务说明"}
            </p>
            {task.status === "archived" ? (
              <p className="mt-3 text-xs text-[#8a958c]">
                此任务已归档，仅保留历史记录和产物，不能再次执行或修改；可复制为新建任务继续使用。
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {task.status === "archived" ? (
              <Link
                href={`/automations/new?copy=${encodeURIComponent(task.taskId)}`}
                className="btn-primary"
              >
                <Copy size={16} />
                复制为新建任务
              </Link>
            ) : null}
            {task.status !== "archived" ? (
              <Link
                href={`/automations/new?edit=${encodeURIComponent(task.taskId)}`}
                className="btn-secondary"
              >
                编辑
              </Link>
            ) : null}
            {task.status !== "archived" ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void archive()}
                disabled={busy !== null}
              >
                <Archive size={16} />
                归档
              </button>
            ) : null}
            {task.status === "active" ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void toggle()}
                disabled={busy !== null}
              >
                {busy === "status" ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Pause size={16} />
                )}
                暂停执行
              </button>
            ) : task.status !== "archived" ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void runNow()}
                disabled={runDisabled}
              >
                {busy === "run" ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Play size={16} />
                )}
                {hasRunningRun ? "运行中" : "立即运行一次"}
              </button>
            ) : null}
            {task.status === "active" ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void runNow()}
                disabled={runDisabled}
              >
                {busy === "run" ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Play size={16} />
                )}
                {hasRunningRun ? "运行中" : "立即运行一次"}
              </button>
            ) : null}
            {task.status !== "active" && task.status !== "archived" ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void toggle()}
                disabled={busy !== null}
              >
                <Play size={16} />
                启用定时
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <Info
            label="执行规则"
            value={formatSchedule(task.revision.schedule)}
          />
          <Info
            label="下次执行"
            value={
              task.nextRunAt
                ? formatDate(task.nextRunAt)
                : task.status === "paused"
                  ? "已暂停"
                  : "暂无安排"
            }
          />
          <Info
            label="连续失败"
            value={
              task.consecutiveFailures
                ? `${task.consecutiveFailures} 次，需要处理`
                : "无"
            }
            danger={task.consecutiveFailures > 0}
          />
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <InfoBlock
            title="附件"
            icon={<Paperclip size={16} />}
            text={
              task.sourceAsset?.fileName ||
              (task.revision.inputs?.length ? "已附加文件" : "未添加附件")
            }
          />
          <InfoBlock
            title="结果投递"
            icon={<Send size={16} />}
            text={deliveryLabel(task.revision.delivery)}
          />
        </div>
        <div className="mt-9">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">最近运行</h3>
              <p className="mt-1 text-xs text-[#89948b]">
                点击一条记录查看完整结果。
              </p>
            </div>
            <Link
              href={`/automations/runs?taskId=${encodeURIComponent(task.taskId)}`}
              className="text-sm text-[#55745d] hover:underline"
            >
              查看全部
            </Link>
          </div>
          <div className="mt-3 overflow-hidden rounded-xl border border-[#edf0ed]">
            {runs.length ? (
              runs.map((run) => <RunRow key={run.runId} run={run} />)
            ) : (
              <p className="px-4 py-8 text-center text-sm text-[#8a958c]">
                还没有运行记录
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function RunDetailViewAccurate({
  runId,
  onError,
}: {
  runId: string;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const filePanel = useFilePanel();
  const [run, setRun] = useState<AutomationTaskRun | null>(null);
  const [task, setTask] = useState<AutomationTask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAutomationRun(runId)
      .then(async (next) => {
        const taskResult = await fetchAutomation(next.taskId);
        if (!cancelled) {
          setRun(next);
          setTask(taskResult);
        }
      })
      .catch((cause) => {
        if (!cancelled) onError(readError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [onError, runId]);
  if (!run)
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Skeleton />
      </main>
    );
  async function continueChat() {
    const currentRun = run;
    if (!currentRun) return;
    setBusy("continue");
    try {
      const result = await continueAutomationInChat(currentRun.runId);
      router.push(
        `/chat?conversationId=${encodeURIComponent(result.conversationId)}`,
      );
    } catch (cause) {
      onError(readError(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 lg:py-8">
      <Link
        href="/automations/runs"
        className="inline-flex items-center gap-1 text-sm text-[#6f7d73] hover:text-[#36543d]"
      >
        <ArrowLeft size={15} />
        返回运行记录
      </Link>
      <div className="mt-5 rounded-2xl border border-[#e0e7e1] bg-white p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StatusRunBadge status={run.status} attempt={run.attempt} />
              <span className="text-xs text-[#8a958c]">
                {run.origin === "manual" ? "手动运行" : "计划运行"}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-semibold">
              {run.taskName || task?.revision.name || "自动化任务"}
            </h2>
            <p className="mt-1 text-xs text-[#8a958c]">运行编号 {run.runId}</p>
          </div>
          {task ? (
            <Link
              href={`/automations/${encodeURIComponent(task.taskId)}`}
              className="btn-secondary"
            >
              查看任务
            </Link>
          ) : null}
        </div>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <Info
            label="计划时间"
            value={run.scheduledFor ? formatDate(run.scheduledFor) : "未设置"}
          />
          <Info
            label="开始时间"
            value={run.startedAt ? formatDate(run.startedAt) : "尚未开始"}
          />
          <Info
            label="完成时间"
            value={run.finishedAt ? formatDate(run.finishedAt) : "进行中"}
          />
          <Info
            label="任务版本"
            value={run.revision ? `版本 ${run.revision}` : run.revisionId}
          />
          <Info
            label="运行尝试"
            value={
              run.attempt && run.attempt > 1
                ? `第 ${run.attempt} 次（已恢复）`
                : "第 1 次"
            }
          />
        </div>
        <div
          className={`mt-5 rounded-xl p-4 ${run.status === "failed" ? "bg-[#fff6f4] text-[#8e4b42]" : "bg-[#f5f8f5] text-[#5c6d61]"}`}
        >
          <p className="text-sm font-medium">
            {run.status === "failed" ? "运行未完成" : "运行结果"}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
            {run.errorMessage || run.resultSummary || "暂无摘要"}
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <InfoBlock
            title="输入资料"
            icon={<Paperclip size={16} />}
            text={
              run.inputVersions?.length
                ? `${run.inputVersions.length} 个输入版本已固定`
                : run.inputAssetId
                  ? "已读取任务输入资料"
                  : "本次没有输入资料"
            }
          />
          <InfoBlock
            title="微信投递"
            icon={<Send size={16} />}
            text={deliveryStatusLabel(run.deliveryStatus)}
          />
        </div>
        <div className="mt-5 border-t border-[#edf1ed] pt-4">
          <p className="text-sm font-medium">本次任务相关文件</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {run.inputVersions?.map((input, index) => (
              <button
                key={`${input.assetId}:${input.versionId}`}
                type="button"
                className="btn-secondary max-w-full"
                onClick={() => filePanel.openAssetPreview({ kind: "asset", assetId: input.assetId, versionId: input.versionId, title: input.fileName || `输入文件 ${index + 1}` })}
              >
                <Paperclip size={15} />
                <span className="max-w-[220px] truncate">{input.fileName || `已读取文件 ${index + 1}`}</span>
              </button>
            ))}
            {run.outputAssetId ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => filePanel.openAssetPreview({ kind: "asset", assetId: run.outputAssetId!, versionId: run.outputVersionId || null, title: "本次变更文件" })}
              >
                <FileSpreadsheet size={15} />
                本次变更文件
              </button>
            ) : null}
            {!run.inputVersions?.length && !run.outputAssetId ? (
              <span className="text-sm text-[#7b887e]">本次没有关联文件</span>
            ) : null}
          </div>
        </div>
        <div className="mt-7 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void continueChat()}
            disabled={busy !== null}
          >
            {busy === "continue" ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ChevronRight size={16} />
            )}
            在对话中继续
          </button>
        </div>
      </div>
    </main>
  );
}

function Info({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-xl bg-[#f6f8f6] px-4 py-3">
      <p className="text-xs text-[#89948b]">{label}</p>
      <p
        className={`mt-1 text-sm font-medium ${danger ? "text-[#a4544a]" : "text-[#405047]"}`}
      >
        {value}
      </p>
    </div>
  );
}
function InfoBlock({
  title,
  icon,
  text,
}: {
  title: string;
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[#e9eee9] p-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#eef5ef] text-[#55765c]">
        {icon}
      </span>
      <div>
        <p className="text-xs text-[#89948b]">{title}</p>
        <p className="mt-1 text-sm font-medium text-[#4b5c50]">{text}</p>
      </div>
    </div>
  );
}
function StatusBadge({ status }: { status: AutomationTaskStatus }) {
  const meta = statusMeta(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ backgroundColor: meta.bg, color: meta.text }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.dot }}
      />
      {meta.label}
    </span>
  );
}
function StatusRunBadge({
  status,
  attempt = 1,
}: {
  status: AutomationTaskRun["status"];
  attempt?: number;
}) {
  const meta = runStatus(status, attempt);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.bg} ${meta.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}
function ErrorBanner({
  message,
  onClose,
  onRetry,
}: {
  message: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-[#f0d2cd] bg-[#fff7f5] px-3 py-2.5 text-sm text-[#984c43]">
      <CircleAlert size={17} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs font-medium text-[#984c43] hover:bg-white"
        onClick={onRetry}
      >
        重试
      </button>
      <button
        type="button"
        aria-label="关闭错误提示"
        className="rounded p-0.5 hover:bg-white"
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </div>
  );
}
function NotFoundState({ onBack }: { onBack: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-20 text-center">
      <CircleAlert size={34} className="mx-auto text-[#9ca8a0]" />
      <h2 className="mt-3 text-lg font-semibold">找不到这个自动化内容</h2>
      <button type="button" className="btn-primary mt-5" onClick={onBack}>
        返回
      </button>
    </main>
  );
}
function Skeleton() {
  return <div className="h-16 animate-pulse rounded-xl bg-[#e9eee9]" />;
}
function statusMeta(status: AutomationTaskStatus) {
  return (
    {
      paused: {
        label: "已暂停",
        dot: "#8b9890",
        bg: "#eef1ef",
        text: "#5f6d64",
      },
      active: {
        label: "定时执行中",
        dot: "#3c9a5a",
        bg: "#eaf6ed",
        text: "#397448",
      },
      needs_attention: {
        label: "需要处理",
        dot: "#d58b32",
        bg: "#fff5df",
        text: "#986118",
      },
      archived: {
        label: "已归档",
        dot: "#9ca49e",
        bg: "#f0f1f0",
        text: "#68716b",
      },
    } as const
  )[status];
}
function runStatus(status: AutomationTaskRun["status"], attempt = 1) {
  const meta = (
    {
      running: {
        label: "运行中",
        dot: "bg-blue-500",
        bg: "bg-blue-50",
        text: "text-blue-700",
      },
      succeeded: {
        label: attempt > 1 ? "恢复后成功" : "成功",
        dot: "bg-emerald-500",
        bg: "bg-emerald-50",
        text: "text-emerald-700",
      },
      failed: {
        label: "失败",
        dot: "bg-red-500",
        bg: "bg-red-50",
        text: "text-red-700",
      },
      skipped: {
        label: "已跳过",
        dot: "bg-slate-100",
        bg: "bg-slate-50",
        text: "text-slate-600",
      },
      cancelled: {
        label: "已取消",
        dot: "bg-zinc-400",
        bg: "bg-zinc-50",
        text: "text-zinc-600",
      },
    } as const
  )[status];
  return meta;
}
function runStatusLabel(status: AutomationTaskRun["status"], attempt = 1) {
  return runStatus(status, attempt).label;
}
function formatSchedule(schedule: AutomationSchedule) {
  const frequency =
    schedule.frequency === "daily"
      ? "每天"
      : schedule.frequency === "trading_days" || schedule.frequency === "weekdays"
        ? "交易日"
        : `每周 ${(schedule.weekdays ?? [])
            .map((day) => WEEKDAYS.find(([value]) => value === day)?.[1])
            .filter(Boolean)
            .join("、")}`;
  return `${frequency} ${schedule.time}`;
}
function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "short",
      });
}
function formatRelative(value: string) {
  const diff = new Date(value).getTime() - Date.now();
  const minutes = Math.round(Math.abs(diff) / 60000);
  if (minutes < 60)
    return diff >= 0 ? `${minutes || 1} 分钟后` : `${minutes || 1} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diff >= 0 ? `${hours} 小时后` : `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return diff >= 0 ? `${days} 天后` : `${days} 天前`;
}
function shanghaiDateBoundary(value: string, offsetDays: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const start = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return undefined;
  start.setUTCDate(start.getUTCDate() + offsetDays);
  return start.toISOString();
}
function startDateForQuery(value: string) {
  return shanghaiDateBoundary(value, 0);
}
function endDateForQuery(value: string) {
  return shanghaiDateBoundary(value, 1);
}
function deliveryLabel(delivery: AutomationTask["revision"]["delivery"]) {
  if (!delivery || delivery.mode === "none") return "不推送";
  return delivery.mode === "wechat_summary"
    ? "完成后推送到微信"
    : "有重要变化时推送到微信";
}
function deliveryStatusLabel(status: AutomationTaskRun["deliveryStatus"]) {
  return (
    (
      {
        not_requested: "未请求",
        pending: "等待投递",
        sent: "已发送",
        suppressed: "按条件未发送",
        failed: "投递失败",
      } as Record<string, string>
    )[status || "not_requested"] || "未投递"
  );
}
function groupRunsByDate(runs: AutomationTaskRun[]) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const detailFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
  const today = formatter.format(new Date());
  const yesterday = formatter.format(new Date(Date.now() - 86400000));
  const groups = new Map<
    string,
    { key: string; label: string; runs: AutomationTaskRun[] }
  >();
  for (const run of runs) {
    const value = run.finishedAt || run.createdAt;
    const key = formatter.format(new Date(value));
    const detail = detailFormatter.formatToParts(new Date(value));
    const month = detail.find((part) => part.type === "month")?.value || "";
    const day = detail.find((part) => part.type === "day")?.value || "";
    const weekday = detail.find((part) => part.type === "weekday")?.value || "";
    const label =
      key === today
        ? "今天"
        : key === yesterday
          ? "昨天"
          : `${weekday}（${month}/${day}）`;
    if (!groups.has(key)) groups.set(key, { key, label, runs: [] });
    groups.get(key)!.runs.push(run);
  }
  return [...groups.values()];
}
function getView(pathname: string | null, workspaceView?: string | null): View {
  const path = pathname || "/automations";
  if (path === "/automations" && workspaceView === "runs") return "runs";
  if (path === "/automations" && workspaceView === "templates")
    return "templates";
  if (path === "/automations" && workspaceView === "patrol")
    return "patrol";
  if (path.endsWith("/templates")) return "templates";
  if (path.endsWith("/new")) return "new";
  if (path.includes("/runs/") && path !== "/automations/runs") return "run";
  if (path.endsWith("/runs")) return "runs";
  if (path !== "/automations" && path.startsWith("/automations/"))
    return "task";
  return "tasks";
}
function isWorkspaceView(view: View): view is WorkspaceView {
  return view === "tasks" || view === "runs" || view === "templates" || view === "patrol";
}
function getId(pathname: string | null, prefix: string) {
  if (!pathname?.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length).split("/")[0];
  return value && value !== "runs" && value !== "templates" && value !== "new"
    ? decodeURIComponent(value)
    : null;
}
function getQuery(key: string) {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get(key) || undefined;
}
function parseQueryList(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
function replaceAutomationQuery(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  current: { toString: () => string },
  changes: Record<string, string | null>,
) {
  const params = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  params.delete("cursor");
  const suffix = params.toString();
  router.replace(`${pathname}${suffix ? `?${suffix}` : ""}`, { scroll: false });
}
function formatFrequency(value: AutomationSchedule["frequency"]) {
  return value === "daily" ? "每天" : value === "weekly" ? "每周" : "交易日";
}
function editorFromTask(task: AutomationTask): EditorState {
  const delivery = task.revision.delivery;
  return {
    ...emptyEditor(),
    name: task.revision.name,
    description: task.revision.description || task.revision.instruction || "",
    frequency: task.revision.schedule.frequency === "weekdays" ? "trading_days" : task.revision.schedule.frequency,
    time: task.revision.schedule.time,
    weekdays: task.revision.schedule.weekdays || [1],
    deliveryEnabled: delivery?.mode !== "none" && Boolean(delivery),
    deliveryMode:
      delivery?.mode === "wechat_on_condition"
        ? "wechat_on_condition"
        : "wechat_summary",
    existingInputs: task.revision.inputs || [],
    existingOutput: task.revision.output || { mode: "none" },
    existingTask: task,
  };
}
function applyTemplate(state: EditorState, template: AutomationTemplate) {
  const preset = template.preset;
  state.name = String(preset.name || template.name);
  state.description = String(preset.instruction || preset.description || "");
  state.frequency = preset.schedule?.frequency || "daily";
  state.time = preset.schedule?.time || "07:30";
  state.weekdays = preset.schedule?.weekdays || [1];
  state.deliveryEnabled =
    preset.delivery?.mode !== "none" && Boolean(preset.delivery);
  state.deliveryMode =
    preset.delivery?.mode === "wechat_on_condition"
      ? "wechat_on_condition"
      : "wechat_summary";
  state.existingOutput = preset.output || { mode: "none" };
}
function readError(cause: unknown) {
  const error = cause as Partial<AutomationApiError>;
  return typeof error?.message === "string" && error.message
    ? error.message
    : "自动化请求失败，请稍后重试";
}
