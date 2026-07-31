import { createHash } from "node:crypto";

import { sanitizeSvgForInline, scanForUnsafeContent } from "./svg-sanitizer.js";

const MAX_INLINE_VISUALS = 2;
const MAX_SVG_BYTES = 64 * 1024;
const SVG_BLOCK = /```invest-svg\s*\r?\n([\s\S]*?)\r?\n```/gi;

export interface InlineSvgVisual {
  version: 1;
  id: string;
  kind: "svg";
  title: string;
  alt: string;
  svg: string;
}

export interface InlineVisualExtraction {
  text: string;
  visuals: InlineSvgVisual[];
}

/**
 * Turns the presentation-only SVG blocks emitted for Portal chats into typed
 * metadata. The SVG never remains in Markdown, so other channels do not
 * accidentally receive or render it.
 */
export function extractInlineSvgVisuals(reply: string): InlineVisualExtraction {
  const visuals: InlineSvgVisual[] = [];
  const text = reply.replace(SVG_BLOCK, (_whole, rawSvg: string) => {
    if (visuals.length >= MAX_INLINE_VISUALS) return "";
    const visual = validateInlineSvg(rawSvg, visuals.length);
    if (visual) visuals.push(visual);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  return {
    text: text || (visuals.length > 0 ? "图示如下。" : ""),
    visuals,
  };
}

function validateInlineSvg(rawSvg: string, index: number): InlineSvgVisual | null {
  const svg = rawSvg.trim();
  if (!svg || Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) return null;
  if (!/^<svg\b[^>]*>/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return null;
  if (/<!doctype|<!entity|<\?/i.test(svg)) return null;

  const openingTag = svg.match(/^<svg\b[^>]*>/i)?.[0] || "";
  if (!hasBoundedViewBox(openingTag)) return null;
  if (!scanForUnsafeContent(svg).safe) return null;

  const sanitized = sanitizeSvgForInline(svg);
  if (!sanitized || Buffer.byteLength(sanitized, "utf8") > MAX_SVG_BYTES) return null;
  const title = svgTitle(sanitized) || "投资分析图示";
  const digest = createHash("sha256").update(sanitized).digest("hex").slice(0, 16);
  return {
    version: 1,
    id: `visual_${digest}_${index + 1}`,
    kind: "svg",
    title,
    alt: title,
    svg: sanitized,
  };
}

function hasBoundedViewBox(openingTag: string) {
  const match = openingTag.match(/\bviewBox\s*=\s*(["'])\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\1/i);
  if (!match) return false;
  const width = Number(match[2]);
  const height = Number(match[3]);
  return Number.isFinite(width) && Number.isFinite(height) && width >= 80 && height >= 80 && width <= 2000 && height <= 2000;
}

function svgTitle(svg: string) {
  const value = svg.match(/<title\b[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
  return value || undefined;
}
