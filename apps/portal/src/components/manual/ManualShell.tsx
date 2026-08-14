"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { MarkdownLite } from "@/components/chat/MarkdownLite";
import { buildManualMarkdown, userManual } from "@/content/user-manual";

type ViewMode = "web" | "document";
type DocumentMode = "pdf" | "md";

export function ManualShell() {
  const [viewMode, setViewMode] = useState<ViewMode>("web");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("pdf");
  const markdown = buildManualMarkdown();

  return (
    <div className="min-h-screen bg-[#f7f7f8] text-[#202123]">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xl text-[#5f6368] transition hover:bg-black/5"
              aria-label="返回聊天"
              title="返回聊天"
              onClick={() => window.location.assign("/chat")}
            >
              ‹
            </button>
            <div className="truncate text-sm font-semibold text-[#343541]">{userManual.title}</div>
          </div>
          <div className="flex shrink-0 rounded-md border border-[#d9d9e3] bg-[#f7f7f8] p-0.5">
            <ModeButton active={viewMode === "web"} onClick={() => setViewMode("web")}>
              网页查看
            </ModeButton>
            <ModeButton active={viewMode === "document"} onClick={() => setViewMode("document")}>
              文档查看
            </ModeButton>
          </div>
        </div>
      </header>

      {viewMode === "web" ? (
        <WebManual />
      ) : (
        <DocumentManual
          mode={documentMode}
          markdown={markdown}
          onModeChange={setDocumentMode}
        />
      )}
    </div>
  );
}

function WebManual() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <section className="border-b border-[#dedee5] pb-9">
        <p className="text-sm font-medium text-[#0f766e]">产品介绍</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-normal text-[#202123]">
          {userManual.title}
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-8 text-[#5f6368]">
          {userManual.subtitle}
        </p>
        <div className="mt-6 border-l-2 border-[#10a37f] pl-4 text-sm leading-7 text-[#155e55]">
          <span className="font-semibold">最终目标：</span>
          {userManual.finalGoal}
        </div>
      </section>

      <section className="py-9">
        <div className="max-w-3xl">
          <h2 className="text-2xl font-semibold">核心优势</h2>
        </div>
        <div className="mt-6 divide-y divide-[#e5e5e5] border-y border-[#e5e5e5] bg-white">
          {userManual.strengths.map((strength) => (
            <div key={strength.title} className="grid gap-2 px-5 py-5 sm:grid-cols-[220px_1fr] sm:gap-7">
              <h3 className="text-sm font-semibold text-[#343541]">{strength.title}</h3>
              <p className="text-sm leading-6 text-[#6b7280]">{strength.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-[#dedee5] py-9">
        <h2 className="text-2xl font-semibold">{userManual.onboarding.title}</h2>
        <ol className="mt-6 grid gap-3 md:grid-cols-2">
          {userManual.onboarding.steps.map((step, index) => (
            <li key={step.title} className="border-l-2 border-[#10a37f] bg-white px-5 py-5">
              <div className="text-xs font-semibold text-[#0f766e]">步骤 {index + 1}</div>
              <h3 className="mt-1 text-base font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#6b7280]">{step.description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-[#dedee5] py-9">
        <h2 className="text-2xl font-semibold">最终为您实现</h2>
        <div className="mt-6 divide-y divide-[#e5e5e5] border-y border-[#e5e5e5] bg-white">
          {userManual.outcomes.map((outcome) => (
            <div key={outcome.title} className="grid gap-2 px-5 py-5 sm:grid-cols-[220px_1fr] sm:gap-7">
              <h3 className="text-sm font-semibold text-[#343541]">{outcome.title}</h3>
              <p className="text-sm leading-6 text-[#6b7280]">{outcome.description}</p>
            </div>
          ))}
        </div>
        {userManual.notes.map((note) => (
          <p key={note} className="mt-7 border-l-2 border-[#b6b6c2] pl-4 text-sm leading-6 text-[#6b7280]">
            {note}
          </p>
        ))}
      </section>
    </main>
  );
}

function DocumentManual({
  mode,
  markdown,
  onModeChange
}: {
  mode: DocumentMode;
  markdown: string;
  onModeChange: (mode: DocumentMode) => void;
}) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-md border border-[#d9d9e3] bg-white p-0.5">
          <ModeButton active={mode === "pdf"} onClick={() => onModeChange("pdf")}>
            PDF
          </ModeButton>
          <ModeButton active={mode === "md"} onClick={() => onModeChange("md")}>
            Markdown
          </ModeButton>
        </div>
        <div className="flex gap-2">
          <a className="btn-secondary" href="/api/manual/download/md">
            下载 MD
          </a>
          <a className="btn-primary" href="/api/manual/download/pdf">
            下载 PDF
          </a>
        </div>
      </div>

      {mode === "pdf" ? (
        <div className="h-[calc(100vh-9.5rem)] min-h-[560px] overflow-hidden border border-[#d9d9e3] bg-white">
          <object
            data="/manual/invest-agent-user-manual.pdf"
            type="application/pdf"
            className="h-full w-full"
          >
            <div className="p-8 text-center text-sm text-[#6b7280]">
              当前浏览器无法预览 PDF，请使用上方“下载 PDF”。
            </div>
          </object>
        </div>
      ) : (
        <article className="chatgpt-prose mx-auto max-w-4xl border border-[#d9d9e3] bg-white px-5 py-8 text-sm leading-7 sm:px-10">
          <MarkdownLite text={markdown} />
        </article>
      )}
    </main>
  );
}

function ModeButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rounded px-3 py-1.5 text-xs font-medium transition ${
        active ? "bg-white text-[#202123] shadow-sm" : "text-[#6b7280] hover:text-[#202123]"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
