"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";

import type { PortalAttachmentPayload } from "./api";
import type { AttachmentView } from "./types";
import { DOCUMENT_MIME, IMAGE_MIME, canonicalAttachmentMime, isCsvFile } from "@/lib/attachment-policy";
import { MODEL_OPTIONS } from "@/lib/models";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 8;
const MAX_TOTAL_BYTES_PER_MESSAGE = 40 * 1024 * 1024;
const MAX_TEXTAREA_HEIGHT = 176;

interface MessageComposerProps {
  disabled: boolean;
  disabledReason?: string;
  processing?: boolean;
  stopping?: boolean;
  /** 按回合模型选择（D25）：空字符串 = 服务端默认模型。 */
  selectedModel: string;
  onModelChange: (model: string) => void;
  onSend: (text: string, attachments: ComposerAttachment[], model?: string) => Promise<void>;
  onCancel?: () => Promise<void>;
}

export interface ComposerAttachment extends PortalAttachmentPayload {
  id: string;
  previewUrl?: string;
}

export function MessageComposer({
  disabled,
  disabledReason,
  processing = false,
  stopping = false,
  selectedModel,
  onModelChange,
  onSend,
  onCancel
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);

  const inputDisabled = disabled || processing || stopping;
  const cancelPending = stopping || cancelRequested;
  const canSend = !inputDisabled && !sending && !error && (value.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    if (!stopping) setCancelRequested(false);
  }, [stopping]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, MAX_TEXTAREA_HEIGHT)}px`;
    textarea.style.overflowY = contentHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, []);

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!canSend) return;
    const text = value.trim();
    const outgoing = attachments;
    setValue("");
    setAttachments([]);
    setSending(true);
    try {
      await onSend(text, outgoing, selectedModel || undefined);
    } finally {
      outgoing.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    if (inputDisabled || sending) return;
    void addFiles(files);
  }

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const incoming = Array.from(files);
    const next: ComposerAttachment[] = [...attachments];
    if (next.length + incoming.length > MAX_FILES_PER_MESSAGE) {
      setError(`单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`);
      return;
    }
    for (const file of incoming) {
      const validation = validateFile(file, next);
      if (validation) {
        setError(validation);
        return;
      }
      next.push(await fileToAttachment(file));
    }
    setAttachments(next);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const item = prev.find((entry) => entry.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((entry) => entry.id !== id);
    });
    setError(null);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    if (inputDisabled || sending) return;
    void addFiles(event.dataTransfer.files);
  }

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!inputDisabled && !sending) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={handleDrop}
      className="border-t border-black/[0.04] bg-white px-3 pb-4 pt-3 sm:px-6"
    >
      <div className="mx-auto max-w-3xl">
        <div className={`rounded-xl border bg-white p-2 shadow-[0_1px_4px_rgba(0,0,0,0.05)] transition focus-within:border-[#7a8d83] focus-within:ring-2 focus-within:ring-[#7a8d83]/10 ${
          dragging ? "border-emerald-400" : "border-black/15"
        }`}>
          {attachments.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-start gap-2 px-1 pt-1">
              {attachments.map((item) => (
                <AttachmentChip
                  key={item.id}
                  attachment={{
                    type: item.kind === "image" ? "image" : "document",
                    fileName: item.fileName,
                    mimeType: item.mimeType,
                    sizeBytes: item.sizeBytes,
                    previewUrl: item.previewUrl
                  }}
                  onRemove={() => removeAttachment(item.id)}
                />
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept={[...IMAGE_MIME, ...DOCUMENT_MIME, ".csv"].join(",")}
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.currentTarget.value = "";
            }}
            disabled={inputDisabled || sending}
          />
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#5f6368] transition hover:bg-black/5 disabled:text-[#c7c7d1]"
            onClick={() => fileInputRef.current?.click()}
            disabled={inputDisabled || sending}
            aria-label="添加附件"
            title="添加附件"
          >
            <Paperclip size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <select
            className="h-9 shrink-0 cursor-pointer rounded-md border border-black/10 bg-[#f7f7f8] px-2 text-xs text-[#5f6368] outline-none transition hover:bg-black/5 focus:border-[#7a8d83] disabled:opacity-50"
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={inputDisabled || sending}
            aria-label="选择模型"
            title="选择模型"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="flex-1">
          <textarea
            ref={textareaRef}
              className="block max-h-44 min-h-[40px] w-full resize-none overflow-y-hidden border-0 bg-transparent px-2 py-2 text-[15px] leading-6 text-[#202123] placeholder-[#8e8ea0] outline-none"
              placeholder={disabled ? (disabledReason ?? "助手暂时离线,本地服务恢复后可继续。") : processing ? "正在等待助手回复..." : "给投资助手发送消息"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={inputDisabled}
          />
        </div>
        {processing || stopping || cancelRequested ? (
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#202421] text-white transition hover:bg-[#303632] disabled:bg-[#d9d9e3]"
            disabled={disabled || !onCancel || cancelPending}
            onClick={async () => {
              if (!onCancel || cancelPending) return;
              setCancelRequested(true);
              try {
                await onCancel();
              } catch {
                setCancelRequested(false);
              }
            }}
            aria-label={cancelPending ? "停止请求已发送" : "停止处理"}
            title={cancelPending ? "停止请求已发送" : "停止处理"}
          >
            <Square size={16} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#202421] text-white transition hover:bg-[#303632] disabled:bg-[#d9d9e3]"
            disabled={!canSend}
            aria-label="发送"
          >
            {sending ? "…" : <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />}
          </button>
        )}
          </div>
      </div>
        {error ? (
          <p className="mt-2 text-xs text-red-600">{error}</p>
        ) : null}
        <p className="mt-2 text-center text-[11px] text-[#8e8ea0]">
          内容仅供投资研究参考，不构成交易建议。
        </p>
      </div>
      {(disabled || processing) && disabledReason ? (
        <p className="mx-auto mt-2 max-w-3xl text-xs text-amber-600">
          {disabledReason}
        </p>
      ) : null}
    </form>
  );
}

function validateFile(file: File, existing: ComposerAttachment[]) {
  const isImage = IMAGE_MIME.includes(file.type);
  const isDocument = DOCUMENT_MIME.includes(canonicalAttachmentMime(file.name, file.type)) || isCsvFile(file.name, file.type);
  if (!isImage && !isDocument) return `不支持 ${file.name || file.type} 的文件类型`;
  const limit = isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (file.size > limit) return `${file.name} 超过 ${formatBytes(limit)} 限制`;
  const total = existing.reduce((sum, item) => sum + item.sizeBytes, 0) + file.size;
  if (total > MAX_TOTAL_BYTES_PER_MESSAGE) return `单条消息附件总大小不能超过 ${formatBytes(MAX_TOTAL_BYTES_PER_MESSAGE)}`;
  return null;
}

async function fileToAttachment(file: File): Promise<ComposerAttachment> {
  const dataUrl = await readFileDataUrl(file);
  const comma = dataUrl.indexOf(",");
  return {
    id: createAttachmentId(),
    kind: IMAGE_MIME.includes(file.type) ? "image" : "document",
    fileName: file.name,
    mimeType: canonicalAttachmentMime(file.name, file.type),
    sizeBytes: file.size,
    base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
    previewUrl: IMAGE_MIME.includes(file.type) ? URL.createObjectURL(file) : undefined
  };
}

function createAttachmentId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `att_${randomId}`;
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取附件失败"));
    reader.readAsDataURL(file);
  });
}

function AttachmentChip({ attachment, onRemove }: { attachment: AttachmentView; onRemove: () => void }) {
  if (attachment.previewUrl) {
    return (
      <div className="group relative h-20 w-20 overflow-hidden rounded-2xl border border-black/10 bg-[#f7f7f8] shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.previewUrl} alt={attachment.fileName} className="h-full w-full object-cover" />
        <button
          type="button"
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-sm leading-none text-white shadow-sm transition hover:bg-black"
          onClick={onRemove}
          aria-label={`移除 ${attachment.fileName}`}
          title="移除附件"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="flex max-w-full items-center gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-[#202123] shadow-sm">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-600 text-[10px] font-semibold text-white">
        {extensionLabel(attachment.fileName)}
      </span>
      <span className="min-w-0">
        <span className="block max-w-[240px] truncate font-medium text-sky-900">{attachment.fileName}</span>
        <span className="block text-[11px] text-sky-700">{formatBytes(attachment.sizeBytes)}</span>
      </span>
      <button
        type="button"
        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sky-700 hover:bg-sky-100 hover:text-sky-950"
        onClick={onRemove}
        aria-label={`移除 ${attachment.fileName}`}
        title="移除附件"
      >
        ×
      </button>
    </div>
  );
}

function extensionLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.slice(0, 4).toUpperCase();
  return ext || "FILE";
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
