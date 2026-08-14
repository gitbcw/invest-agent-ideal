"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import React, { type CSSProperties, type ReactNode } from "react";

interface MarkdownLiteProps {
  text: string;
  /**
   * Called when a legacy `/home/claude/.../reports/...` link is clicked, with
   * the relative `reports/...` path. The parent should resolve it via the
   * artifact legacy publish flow and open the same viewer used for first-class
   * artifacts. If unset, the link falls back to a forced-download URL.
   */
  onLegacyReportPath?: (relativePath: string) => void;
  /**
   * Called when a chat-delivered asset link (`/api/assets/:assetId/versions/
   * :versionId/download`, the URL spreadsheet.create returns as delivery.url)
   * is clicked. The parent should open the file-panel preview. If unset, the
   * link falls back to opening the raw download URL in a new tab.
   */
  onAssetDownloadPath?: (target: { assetId: string; versionId: string; label: string }) => void;
}

/**
 * Markdown renderer for assistant replies.
 *
 * react-markdown escapes raw HTML by default. Do not add rehype-raw here unless
 * we also add a strict sanitizer.
 */
export function MarkdownLite({ text, onLegacyReportPath, onAssetDownloadPath }: MarkdownLiteProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p({ children }) {
          return <p className="whitespace-pre-wrap break-words">{children}</p>;
        },
        a({ children, href }) {
          const assetTarget = extractAssetDownloadTarget(href);
          if (assetTarget && onAssetDownloadPath) {
            const label = nodeText(children) || assetTarget.versionId;
            return (
              <button
                type="button"
                className="text-accent-600 underline underline-offset-2 hover:text-accent-700"
                onClick={() => onAssetDownloadPath({ ...assetTarget, label })}
              >
                {children}
              </button>
            );
          }
          const legacyPath = extractLegacyReportRelativePath(href);
          if (legacyPath && onLegacyReportPath) {
            return (
              <button
                type="button"
                className="text-accent-600 underline underline-offset-2 hover:text-accent-700"
                onClick={() => onLegacyReportPath(legacyPath)}
              >
                {children}
              </button>
            );
          }
          const reportHref = legacyPath ? `/api/${legacyPath}` : href;
          return (
            <a
              className="text-accent-600 underline underline-offset-2 hover:text-accent-700"
              href={reportHref}
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          );
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-2 border-ink-300 pl-3 text-ink-600 dark:border-ink-600 dark:text-ink-300">
              {children}
            </blockquote>
          );
        },
        ul({ children }) {
          return <ul className="ml-5 list-disc space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="ml-5 list-decimal space-y-1">{children}</ol>;
        },
        li({ children }) {
          return <li className="pl-1">{children}</li>;
        },
        hr() {
          return <hr className="my-4 border-ink-200 dark:border-ink-700" />;
        },
        code({ children, className }) {
          const isBlock = Boolean(className);
          if (isBlock) {
            return (
              <code className={className}>
                {children}
              </code>
            );
          }
          return (
            <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[0.85em] text-ink-800 dark:bg-ink-800 dark:text-ink-100">
              {children}
            </code>
          );
        },
        pre({ children }) {
          return (
            <pre className="my-3 overflow-x-auto rounded-lg bg-ink-900 p-3 text-sm leading-6 text-ink-50">
              {children}
            </pre>
          );
        },
        table({ children }) {
          return (
            <div className="responsive-data-table-scroll my-3 overflow-x-auto rounded-lg border border-ink-200 dark:border-ink-700">
              <table className="responsive-data-table border-collapse text-left text-sm">{children}</table>
            </div>
          );
        },
        thead: MarkdownTableHead,
        tbody: MarkdownTableBody,
        tr: MarkdownTableRow,
        th: MarkdownTableHeaderCell,
        td: MarkdownTableCell,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

interface TableNodeProps {
  children?: ReactNode;
  style?: CSSProperties;
}

function MarkdownTableHead({ children }: TableNodeProps) {
  return <thead className="bg-ink-50 dark:bg-ink-800">{children}</thead>;
}

function MarkdownTableBody({ children }: TableNodeProps) {
  return <tbody className="divide-y divide-ink-100 dark:divide-ink-800">{children}</tbody>;
}

function MarkdownTableRow({ children }: TableNodeProps) {
  return <tr>{children}</tr>;
}

function MarkdownTableHeaderCell({ children, style }: TableNodeProps) {
  return (
    <th className="break-words px-3 py-2 font-semibold text-ink-900 dark:text-ink-100" style={style}>
      {children}
    </th>
  );
}

function MarkdownTableCell({ children, style }: TableNodeProps) {
  return (
    <td className="break-words px-3 py-2 align-top text-ink-800 dark:text-ink-100" style={style}>
      {children}
    </td>
  );
}

/**
 * Returns the `reports/...` relative path for a legacy runtime workspace link,
 * or undefined if the href is not a legacy report URL. The portal converts
 * these into descriptor-gated viewer flows instead of inline same-origin SVG.
 */
function extractLegacyReportRelativePath(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const match = href.match(
    /^(?:\/home\/[^/]+\/invest-agent-data\/workspaces\/[^/]+\/)?(reports\/(?:[^/]+\/)*[^/]+)$/
  );
  if (!match) return undefined;
  return match[1];
}

/** Matches the chat-delivered asset download URL returned as delivery.url. */
function extractAssetDownloadTarget(href: string | undefined): { assetId: string; versionId: string } | undefined {
  if (!href) return undefined;
  const match = href.match(/^\/api\/assets\/([^/?#]+)\/versions\/([^/?#]+)\/download(?:[?#].*)?$/);
  if (!match) return undefined;
  return { assetId: decodeURIComponent(match[1]), versionId: decodeURIComponent(match[2]) };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return "";
}
