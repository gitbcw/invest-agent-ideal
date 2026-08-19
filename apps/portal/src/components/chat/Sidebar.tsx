"use client";

import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { AlarmClock, Check, ChevronDown, ChevronRight, Files, Folder, FolderPlus, MessageCircle, PanelLeftClose, PanelLeftOpen, Pencil, Search, SquarePen, Tag, Trash2, X } from "lucide-react";

import type { ConversationListItem } from "./types";
import { UserMenu } from "./UserMenu";

const SHOW_UNSTABLE_DESTINATIONS = true;

export interface ConversationLabelView { label_id: string; name: string; position: number; }

interface SidebarProps {
  conversations: ConversationListItem[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  loading: boolean;
  hasNext: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onLoadMore: () => void;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  onRename: (conversation: ConversationListItem, name: string) => void;
  onDelete: (conversation: ConversationListItem) => void;
  labels: ConversationLabelView[];
  onCreateLabel: (name: string) => void;
  onRenameLabel: (label: ConversationLabelView, name: string) => void;
  onDeleteLabel: (label: ConversationLabelView) => void;
  onDropConversation: (conversation: ConversationListItem, labelId: string | null) => void;
  onDropConversationOrder: (conversation: ConversationListItem, target: ConversationListItem) => void;
  username: string;
  activeDestination?: "automations" | "assets" | "patrol";
  onOpenAutomations: () => void;
  onOpenAssets: () => void;
  onOpenManual: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
  onOpenUsage: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  collapsed,
  onToggleCollapsed,
  loading,
  hasNext,
  searchQuery,
  onSearchChange,
  onLoadMore,
  onSelect,
  onNewConversation,
  onRename,
  onDelete,
  labels,
  onCreateLabel,
  onRenameLabel,
  onDeleteLabel,
  onDropConversation,
  onDropConversationOrder,
  username,
  activeDestination,
  onOpenAutomations,
  onOpenAssets,
  onOpenManual,
  onChangePassword,
  onLogout,
  onOpenUsage
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [expandedLabelIds, setExpandedLabelIds] = useState<Record<string, boolean>>({});
  const [labelDraft, setLabelDraft] = useState("");
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [renamingLabelId, setRenamingLabelId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!searchOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleCloseSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  function handleOpenSearch() {
    setSearchOpen(true);
  }

  function handleCloseSearch() {
    setSearchOpen(false);
    onSearchChange("");
  }

  function handleSearchSelect(conversationId: string) {
    handleCloseSearch();
    onSelect(conversationId);
  }

  function handleSearchNewConversation() {
    handleCloseSearch();
    onNewConversation();
  }

  function toggleLabel(labelId: string) {
    setExpandedLabelIds((current) => ({ ...current, [labelId]: !current[labelId] }));
  }

  function submitCreateLabel() {
    const name = labelDraft.trim();
    if (!name) return;
    onCreateLabel(name);
    setLabelDraft("");
    setCreatingLabel(false);
  }

  function submitRenameLabel(label: ConversationLabelView) {
    const name = renameDraft.trim();
    if (!name) return;
    onRenameLabel(label, name);
    setRenamingLabelId(null);
  }

  if (collapsed) {
    return (
      <>
        <aside className="sticky top-0 flex h-screen w-14 shrink-0 flex-col border-r border-[#dce0dc] bg-[#f1f3f1] px-3 py-3 text-[#202123]">
          <div className="group relative">
          <button
            type="button"
            className="relative flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-black/5"
            aria-label="展开侧栏"
            title="展开侧栏"
            onClick={onToggleCollapsed}
          >
            <ProductMark className="transition-opacity duration-150 group-hover:opacity-0" />
            <PanelLeftOpen className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" size={18} aria-hidden="true" />
          </button>
          <span role="tooltip" className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-[#202421] px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100">
            展开侧栏
          </span>
          </div>
          <div className="mt-3 flex flex-col gap-1 border-t border-[#dce0dc] pt-3">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#5f6368] transition hover:bg-black/5 hover:text-[#202123]"
            aria-label="新建对话"
            title="新建对话"
            onClick={onNewConversation}
          >
            <SquarePen size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[#5f6368] transition hover:bg-black/5 hover:text-[#202123]"
              aria-label="搜索聊天标题"
              title="搜索聊天标题"
              onClick={handleOpenSearch}
            >
              <Search size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
            {SHOW_UNSTABLE_DESTINATIONS ? (
              <>
                <button
                  type="button"
                  className={`flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-black/5 hover:text-[#202123] ${activeDestination === "automations" ? "bg-white text-[#365b40] shadow-sm" : "text-[#5f6368]"}`}
                  aria-label="自动化任务"
                  title="自动化任务"
                  onClick={onOpenAutomations}
                >
                  <AlarmClock size={17} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-black/5 hover:text-[#202123] ${activeDestination === "assets" ? "bg-white text-[#365b40] shadow-sm" : "text-[#5f6368]"}`}
                  aria-label="我的文件"
                  title="我的文件"
                  onClick={onOpenAssets}
                >
                  <Files size={17} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
          <div className="mt-auto border-t border-[#dce0dc] pt-3">
            <UserMenu
              compact
              username={username}
              onOpenManual={onOpenManual}
              onChangePassword={onChangePassword}
              onLogout={onLogout}
          onOpenUsage={onOpenUsage}
            />
          </div>
        </aside>
        <ConversationSearchDialog
          open={searchOpen}
          query={searchQuery}
          conversations={conversations}
          loading={loading}
          hasNext={hasNext}
          onQueryChange={onSearchChange}
          onClose={handleCloseSearch}
          onSelect={handleSearchSelect}
          onNewConversation={handleSearchNewConversation}
          onLoadMore={onLoadMore}
        />
      </>
    );
  }
  return (
    <>
      <aside className="sticky top-0 flex h-screen w-[224px] shrink-0 flex-col border-r border-[#dce0dc] bg-[#f1f3f1] text-[#202123]">
      <div className="flex h-14 items-center justify-between border-b border-[#dce0dc] bg-[#eef1ee] px-3">
        <ProductBrand />
        <div className="group relative">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#5f6368] transition hover:bg-black/5 hover:text-[#202123]"
            aria-label="收起侧栏"
            title="收起侧栏"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose size={18} aria-hidden="true" />
          </button>
          <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded-md bg-[#202421] px-2 py-1 text-xs text-white opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100">
            收起侧栏
          </span>
        </div>
      </div>
      <div className="space-y-0.5 border-b border-[#dce0dc] bg-[#f4f6f4] px-3 py-2">
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[#303632] transition hover:bg-black/5"
          onClick={onNewConversation}
        >
          <SquarePen size={16} strokeWidth={1.8} aria-hidden="true" />
          创建新聊天
        </button>
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[#303632] transition hover:bg-black/5"
          onClick={handleOpenSearch}
        >
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          搜索聊天标题
        </button>
        {SHOW_UNSTABLE_DESTINATIONS ? (
          <>
            <button
              type="button"
              className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition hover:bg-black/5 ${activeDestination === "automations" ? "bg-white font-medium text-[#365b40] shadow-sm" : "text-[#303632]"}`}
              onClick={onOpenAutomations}
            >
              <AlarmClock size={16} strokeWidth={1.8} aria-hidden="true" />
              自动化任务
            </button>
            <button type="button" className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition hover:bg-black/5 ${activeDestination === "assets" ? "bg-white font-medium text-[#365b40] shadow-sm" : "text-[#303632]"}`} aria-label="我的文件" title="我的文件" onClick={onOpenAssets}>
              <Files size={16} strokeWidth={1.8} aria-hidden="true" />
              我的文件
            </button>
          </>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        {loading && conversations.length === 0 ? <SkeletonList /> : (
          <div className="space-y-1">
            <ConversationFolder labelId={null} label="未分类" expanded={expandedLabelIds.default !== false} conversations={conversations.filter((item) => !item.labelId)} activeId={activeId} onToggle={() => toggleLabel("default")} onDrop={(event) => onDropConversationFromDefault(event)} onSelect={onSelect} onRename={onRename} onDelete={onDelete} onDropConversationOrder={onDropConversationOrLabel} />
            <div className="mt-2 border-t border-[#dce0dc] pt-2">
              <button type="button" className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-[#6e766f] transition hover:bg-[#e8ece9] hover:text-[#343b36]" aria-label="新建标签" onClick={() => setCreatingLabel(true)}><FolderPlus size={14} /><span>新建标签</span></button>
              {creatingLabel ? <div className="mt-1 flex gap-1 px-2"><input autoFocus value={labelDraft} onChange={(event) => setLabelDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitCreateLabel(); if (event.key === "Escape") setCreatingLabel(false); }} className="min-w-0 flex-1 rounded border border-[#c8cfca] bg-white px-2 py-1 text-xs outline-none focus:border-[#52705f]" placeholder="标签名称" /><button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-black/5" aria-label="确认新建标签" onClick={submitCreateLabel}><Check size={15} /></button></div> : null}
            </div>
            {labels.map((label) => {
              const expanded = expandedLabelIds[label.label_id] === true;
              return <section key={label.label_id} className="group rounded-md">
                <div className="flex h-8 items-center gap-1 rounded-md px-1 hover:bg-[#e8ece9]" onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDropConversationToLabel(label.label_id, event)}>
                  <button type="button" className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-xs text-[#343b36]" onClick={() => toggleLabel(label.label_id)} aria-expanded={expanded}>
                    <Tag size={13} /><span className="max-w-[120px] truncate">{label.name}</span><span className="shrink-0 text-[#8a918d]">{conversations.filter((item) => item.labelId === label.label_id).length}</span>{expanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                  </button>
                  <button type="button" className="hidden h-6 w-6 items-center justify-center rounded text-[#737b76] hover:bg-black/5 group-hover:flex" aria-label={`重命名标签 ${label.name}`} onClick={() => { setRenamingLabelId(label.label_id); setRenameDraft(label.name); }}><Pencil size={12} /></button>
                  <button type="button" className="hidden h-6 w-6 items-center justify-center rounded text-[#737b76] hover:bg-black/5 group-hover:flex" aria-label={`删除标签 ${label.name}`} onClick={() => onDeleteLabel(label)}><Trash2 size={12} /></button>
                </div>
                {renamingLabelId === label.label_id ? <div className="mb-1 flex gap-1 px-2"><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitRenameLabel(label); if (event.key === "Escape") setRenamingLabelId(null); }} className="min-w-0 flex-1 rounded border border-[#c8cfca] bg-white px-2 py-1 text-xs outline-none focus:border-[#52705f]" /><button type="button" className="flex h-7 w-7 items-center justify-center rounded hover:bg-black/5" aria-label="确认重命名标签" onClick={() => submitRenameLabel(label)}><Check size={15} /></button></div> : null}
                {expanded ? <ConversationFolder labelId={label.label_id} label={label.name} expanded conversations={conversations.filter((item) => item.labelId === label.label_id)} activeId={activeId} onToggle={() => toggleLabel(label.label_id)} onDrop={(event) => onDropConversationToLabel(label.label_id, event)} onSelect={onSelect} onRename={onRename} onDelete={onDelete} onDropConversationOrder={onDropConversationOrLabel} nested /> : null}
              </section>;
            })}
          </div>
        )}
        {hasNext ? (
          <div className="px-3 py-2 text-center">
            <button type="button" className="w-full rounded-lg px-3 py-2 text-sm text-[#6b7280] transition hover:bg-white hover:text-[#202123]" onClick={onLoadMore}>
              加载更早
            </button>
          </div>
        ) : null}
      </div>
      <div className="border-t border-[#dce0dc] bg-[#eef1ee] p-2">
        <UserMenu
          username={username}
          onOpenManual={onOpenManual}
          onChangePassword={onChangePassword}
          onLogout={onLogout}
          onOpenUsage={onOpenUsage}
        />
      </div>
      </aside>
      <ConversationSearchDialog
        open={searchOpen}
        query={searchQuery}
        conversations={conversations}
        loading={loading}
        hasNext={hasNext}
        onQueryChange={onSearchChange}
        onClose={handleCloseSearch}
        onSelect={handleSearchSelect}
        onNewConversation={handleSearchNewConversation}
        onLoadMore={onLoadMore}
      />
    </>
  );

  function onDropConversationFromDefault(event: DragEvent) {
    const id = event.dataTransfer.getData("text/conversation");
    const conversation = id ? conversations.find((item) => item.conversationId === id) : undefined;
    if (conversation) onDropConversation(conversation, null);
  }
  function onDropConversationToLabel(labelId: string, event: DragEvent) {
    const id = event.dataTransfer.getData("text/conversation");
    if (!id) return;
    event.stopPropagation();
    const conversation = conversations.find((item) => item.conversationId === id);
    if (conversation) onDropConversation(conversation, labelId);
  }
  function onDropConversationOrLabel(target: ConversationListItem, event: DragEvent) {
    event.stopPropagation();
    const conversationId = event.dataTransfer.getData("text/conversation");
    const conversation = conversationId ? conversations.find((item) => item.conversationId === conversationId) : undefined;
    if (conversation && conversation.conversationId !== target.conversationId) onDropConversationOrder(conversation, target);
  }
}

function ConversationFolder({
  label,
  expanded,
  conversations,
  activeId,
  onToggle,
  onDrop,
  onSelect,
  onRename,
  onDelete,
  onDropConversationOrder,
  nested = false
}: {
  labelId: string | null;
  label: string;
  expanded: boolean;
  conversations: ConversationListItem[];
  activeId: string | null;
  onToggle: () => void;
  onDrop: (event: DragEvent) => void;
  onSelect: (conversationId: string) => void;
  onRename: (conversation: ConversationListItem, name: string) => void;
  onDelete: (conversation: ConversationListItem) => void;
  onDropConversationOrder: (target: ConversationListItem, event: DragEvent) => void;
  nested?: boolean;
}) {
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [conversationRenameDraft, setConversationRenameDraft] = useState("");

  function startRenameConversation(conversation: ConversationListItem) {
    setRenamingConversationId(conversation.conversationId);
    setConversationRenameDraft(conversation.title);
  }

  function submitRenameConversation(conversation: ConversationListItem) {
    const name = conversationRenameDraft.trim();
    if (!name) return;
    onRename(conversation, name);
    setRenamingConversationId(null);
  }

  return (
    <section className={nested ? "ml-3 border-l border-[#dce0dc] pl-1" : "rounded-md"} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {!nested ? <button type="button" className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-[#343b36] hover:bg-[#e8ece9]" onClick={onToggle} aria-expanded={expanded}><Folder size={13} /><span>{label}</span><span className="text-[#8a918d]">{conversations.length}</span>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : null}
      {expanded ? <ul className="space-y-0.5 py-0.5">{conversations.map((conversation) => (
        <li key={conversation.conversationId} className="group relative" draggable={renamingConversationId !== conversation.conversationId} onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData("text/conversation", conversation.conversationId); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); onDropConversationOrder(conversation, event); }}>
          {renamingConversationId === conversation.conversationId ? (
            <div className="flex h-9 items-center gap-1 rounded-md bg-white px-2">
              <input autoFocus value={conversationRenameDraft} onChange={(event) => setConversationRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitRenameConversation(conversation); if (event.key === "Escape") setRenamingConversationId(null); }} className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" aria-label="新的对话名称" />
              <button type="button" className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#6e766f] hover:bg-black/5 hover:text-[#202123]" aria-label="确认重命名对话" title="确认重命名" onClick={() => submitRenameConversation(conversation)}><Check size={14} /></button>
            </div>
          ) : <>
            <button type="button" className={`flex h-9 w-full items-center gap-2 rounded-md px-2 pr-[72px] text-left text-sm transition ${activeId === conversation.conversationId ? "bg-[#fff5f5] text-[#202421]" : "text-[#343b36] hover:bg-[#e8ece9]"}`} onClick={() => onSelect(conversation.conversationId)}>
              <span className="min-w-0 flex-1 truncate">{conversation.title || "新的对话"}</span>{conversation.processing ? <span className="shrink-0 text-[11px] text-[#7a3d40]">处理中</span> : null}
            </button>
            <div className="group/actions absolute right-1 top-1 flex h-7 w-[56px] items-center justify-end">
              <span className="text-[11px] text-[#8a918d] transition-opacity group-hover/actions:opacity-0">{formatConversationRelativeTime(conversation.updatedAt)}</span>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 rounded-md bg-[#f1f3f1] px-0.5 opacity-0 transition-opacity group-hover/actions:pointer-events-auto group-hover/actions:opacity-100">
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded text-[#6e766f] hover:bg-black/5 hover:text-[#202123]" aria-label="重命名对话" title="重命名" onClick={(event) => { event.stopPropagation(); startRenameConversation(conversation); }}><Pencil size={14} /></button>
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded text-[#6e766f] hover:bg-red-50 hover:text-red-700" aria-label="删除对话" title="删除" onClick={(event) => { event.stopPropagation(); onDelete(conversation); }}><Trash2 size={14} /></button>
              </div>
            </div>
          </>}
        </li>
      ))}</ul> : null}
      {expanded && conversations.length === 0 ? <div className="mx-2 rounded border border-dashed border-[#d5dbd6] px-2 py-2 text-xs text-[#8a918d]">拖动对话到这里</div> : null}
    </section>
  );
}

function formatConversationRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (elapsed < day) {
    const hours = Math.floor(elapsed / hour);
    return hours > 0 ? `${hours}小时前` : "刚刚";
  }
  const days = Math.floor(elapsed / day);
  if (days === 1) return "一天前";
  if (days === 2) return "两天前";
  if (days === 3) return "三天前";
  return `${days}天前`;
}

function ConversationSearchDialog({
  open,
  query,
  conversations,
  loading,
  hasNext,
  onQueryChange,
  onClose,
  onSelect,
  onNewConversation,
  onLoadMore
}: {
  open: boolean;
  query: string;
  conversations: ConversationListItem[];
  loading: boolean;
  hasNext: boolean;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  onLoadMore: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  const groups = groupConversationsByDate(conversations);

  return (
    <div className="fixed inset-0 z-40 bg-black/20 p-4 sm:p-6" role="presentation" onMouseDown={onClose}>
      <section
        className="absolute left-1/2 top-6 flex max-h-[calc(100vh-3rem)] w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] border border-[#d9ddda] bg-white shadow-[0_20px_45px_rgba(32,36,33,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label="搜索聊天标题"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-16 shrink-0 items-center border-b border-[#e3e5e4] px-5">
          <Search className="mr-3 text-[#6c746f]" size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索聊天标题..."
            className="min-w-0 flex-1 bg-transparent text-base text-[#202123] outline-none placeholder:text-[#9aa09c]"
          />
          <button
            type="button"
            className="ml-3 flex h-8 w-8 items-center justify-center rounded-md text-[#8a918d] transition hover:bg-black/5 hover:text-[#343b36]"
            aria-label="关闭搜索"
            title="关闭搜索"
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-3 py-3">
          <button
            type="button"
            className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-[#303632] transition hover:bg-[#f4f6f4]"
            onClick={onNewConversation}
          >
            <SquarePen size={17} strokeWidth={1.8} aria-hidden="true" />
            创建新聊天
          </button>
          {loading && conversations.length === 0 ? (
            <div className="px-3 py-8 text-sm text-[#7d847f]">正在搜索...</div>
          ) : groups.length === 0 ? (
            <div className="px-3 py-8 text-sm text-[#7d847f]">没有找到匹配的聊天。</div>
          ) : (
            groups.map(([label, items]) => (
              <div key={label} className="mt-3">
                <div className="px-3 pb-1 text-xs text-[#858c87]">{label}</div>
                <ul>
                  {items.map((conversation) => (
                    <li key={conversation.conversationId}>
                      <button
                        type="button"
                        className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-[#303632] transition hover:bg-[#f4f6f4]"
                        onClick={() => onSelect(conversation.conversationId)}
                      >
                        <MessageCircle className="shrink-0 text-[#505853]" size={17} strokeWidth={1.6} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{conversation.title || "新的对话"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {hasNext ? (
            <button
              type="button"
              className="mt-2 w-full rounded-md px-3 py-2 text-sm text-[#5f6b64] transition hover:bg-[#f4f6f4]"
              onClick={onLoadMore}
            >
              加载更多匹配聊天
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function groupConversationsByDate(conversations: ConversationListItem[]): Array<[string, ConversationListItem[]]> {
  const groups = new Map<string, ConversationListItem[]>();
  for (const conversation of conversations) {
    const label = formatConversationGroupDate(conversation.updatedAt);
    const items = groups.get(label) ?? [];
    items.push(conversation);
    groups.set(label, items);
  }
  return [...groups.entries()];
}

function formatConversationGroupDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "较早";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (daysAgo === 0) return "今天";
  if (daysAgo <= 7) return "7 天内";
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1} 月`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit" });
}

function ProductMark({ className = "" }: { className?: string }) {
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center ${className}`} aria-label="澜策">
      <img src="/brand/lance-brand-mark-v4.svg" alt="" className="h-7 w-7" />
    </div>
  );
}

function ProductBrand() {
  return (
    <div className="flex min-w-0 items-center" aria-label="澜策">
      <img src="/brand/lance-wordmark-dynamic.svg" alt="澜策" className="h-11 w-auto max-w-[190px]" />
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="space-y-2 px-1">
      {Array.from({ length: 5 }).map((_, idx) => (
        <li key={idx} className="space-y-2 rounded-lg bg-white px-3 py-3 ring-1 ring-[#ececf1]">
          <div className="h-3 w-2/3 animate-pulse rounded bg-[#e5e7eb]" />
          <div className="h-2.5 w-1/3 animate-pulse rounded bg-[#f0f0f0]" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-8 text-center text-xs text-[#8e8ea0]">
      <p>还没有对话。</p>
      <p className="mt-1">点击上方“新建对话”开始。</p>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  danger,
  onClick
}: {
  icon: typeof Pencil;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[#f4f5f4] ${danger ? "text-red-600" : "text-[#343541]"}`}
      onClick={onClick}
    >
      <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function formatConversationTurnCount(messageCount: number): number {
  return Math.max(1, Math.ceil(messageCount / 2));
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}
