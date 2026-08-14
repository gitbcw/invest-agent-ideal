"use client";

import { useCallback, useEffect, useState } from "react";

import { confirmArtifactDelete, prepareArtifactDelete } from "./api";
import { formatBytes } from "./media-helpers";
import type { ArtifactLibraryCategory } from "@/lib/protocol";

interface DeleteArtifactModalProps {
  artifactId: string;
  initialTitle?: string;
  onClose: () => void;
  onDeleted: (artifactId: string) => void;
}

interface ConfirmData {
  tokenId: string;
  title: string;
  fileName: string;
  displayPath: string;
  sizeBytes: number;
  category: ArtifactLibraryCategory;
  impactNotes: string[];
  expiresAt: string;
}

type Phase =
  | { kind: "preparing" }
  | ({ kind: "confirm" } & ConfirmData)
  | ({ kind: "confirming" } & ConfirmData)
  | { kind: "done"; purgeAt: string }
  | { kind: "error"; reason: string; retryable: boolean; allowReprepare: boolean };

const CATEGORY_LABEL: Record<ArtifactLibraryCategory, string> = {
  daily: "日复盘",
  weekly: "周复盘",
  monthly: "月复盘",
  company: "公司与财务分析",
  metrics: "决策指标与图表",
  memory: "投资记忆摘要",
  other: "其他产物"
};

/**
 * Two-step delete confirmation dialog.
 *
 * 1. On open, calls prepare to fetch a single-use token + impact notes.
 * 2. Shows the confirmation UI with ALL impact notes (work package §8.2).
 * 3. On confirm, calls confirm with the token. The runtime moves the file to
 *    the 30-day hidden trash and tombstones same-path versions.
 *
 * Token replay / expiry / conflict surface deterministic errors and let the
 * user re-prepare. Cancel at any phase has no side effects (§13 item 8).
 */
export function DeleteArtifactModal({ artifactId, onClose, onDeleted }: DeleteArtifactModalProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "preparing" });

  const prepare = useCallback(async () => {
    setPhase({ kind: "preparing" });
    const outcome = await prepareArtifactDelete(artifactId);
    if (!outcome.ok) {
      // NOT_DELETABLE / transient / pre-backfill NULL rows: surface but do not
      // offer re-prepare (the underlying condition won't change on retry).
      const allowReprepare = outcome.code !== "ARTIFACT_NOT_DELETABLE";
      setPhase({
        kind: "error",
        reason: outcome.message || "无法删除该文件",
        retryable: outcome.code === "CONNECTOR_OFFLINE" || outcome.code === "TIMEOUT",
        allowReprepare
      });
      return;
    }
    const d = outcome.data;
    setPhase({
      kind: "confirm",
      tokenId: d.tokenId,
      title: d.title,
      fileName: d.fileName,
      displayPath: d.displayPath,
      sizeBytes: d.sizeBytes,
      category: d.category,
      impactNotes: d.impactNotes,
      expiresAt: d.expiresAt
    });
  }, [artifactId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  // Esc cancels. Only armed when not in the middle of a destructive confirm.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phase.kind !== "confirming") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase.kind]);

  const handleConfirm = useCallback(async () => {
    if (phase.kind !== "confirm") return;
    const { kind: _kind, ...data } = phase;
    void _kind;
    setPhase({ kind: "confirming", ...data });
    const outcome = await confirmArtifactDelete(artifactId, phase.tokenId);
    if (!outcome.ok) {
      // Token expired/replayed/forged → user can re-prepare. Conflict means
      // the file changed between prepare and confirm → also re-prepare.
      const allowReprepare =
        outcome.code === "ARTIFACT_DELETE_CONFIRMATION_EXPIRED" ||
        outcome.code === "ARTIFACT_DELETE_CONFIRMATION_REQUIRED" ||
        outcome.code === "ARTIFACT_DELETE_CONFLICT";
      setPhase({
        kind: "error",
        reason: outcome.message || "删除失败",
        retryable: false,
        allowReprepare
      });
      return;
    }
    setPhase({ kind: "done", purgeAt: outcome.data.purgeAt });
    onDeleted(artifactId);
  }, [artifactId, onDeleted, phase]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="删除文档确认"
      onClick={(e) => {
        if (e.target === e.currentTarget && phase.kind !== "confirming") onClose();
      }}
    >
      <div className="w-[440px] max-w-[92vw] rounded-lg bg-white p-5 shadow-xl">
        {phase.kind === "preparing" ? (
          <div className="py-6 text-center text-sm text-[#5f6368]">正在准备删除确认…</div>
        ) : null}

        {phase.kind === "confirm" || phase.kind === "confirming" ? (
          <div>
            <div className="text-sm font-semibold text-[#202123]">确认从文档库删除？</div>
            <div className="mt-2 rounded-md bg-[#f7f7f8] px-3 py-2 text-xs text-[#343541]">
              <div className="truncate font-medium">{phase.title}</div>
              <div className="mt-0.5 truncate text-[#8e8ea0]">
                {CATEGORY_LABEL[phase.category]} · {phase.displayPath} · {formatBytes(phase.sizeBytes)}
              </div>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-[#5f6368]">
              {phase.impactNotes.map((note, idx) => (
                <li key={idx}>{note}</li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs font-medium text-[#5f6368] transition hover:bg-black/5 disabled:opacity-50"
                onClick={onClose}
                disabled={phase.kind === "confirming"}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleConfirm()}
                disabled={phase.kind === "confirming"}
              >
                {phase.kind === "confirming" ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        ) : null}

        {phase.kind === "done" ? (
          <div>
            <div className="text-sm font-semibold text-[#202123]">已删除</div>
            <p className="mt-2 text-xs leading-5 text-[#5f6368]">
              文件已从文档库移除,系统保留 30 天隐藏恢复窗口（至 {phase.purgeAt.slice(0, 10)}），之后永久清除。
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs font-medium text-[#5f6368] transition hover:bg-black/5"
                onClick={onClose}
              >
                关闭
              </button>
            </div>
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div>
            <div className="text-sm font-semibold text-red-700">无法删除</div>
            <p className="mt-2 text-xs leading-5 text-[#5f6368]">{phase.reason}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs font-medium text-[#5f6368] transition hover:bg-black/5"
                onClick={onClose}
              >
                关闭
              </button>
              {phase.allowReprepare ? (
                <button
                  type="button"
                  className="rounded-md bg-[#202123] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-black"
                  onClick={() => void prepare()}
                >
                  重新确认
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
