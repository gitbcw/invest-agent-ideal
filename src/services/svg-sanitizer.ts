/**
 * Conservative SVG sanitizer for inline rendering.
 *
 * The goal is to render the clean kinds of SVG that show up as agent artifacts
 * (flow charts, simple diagrams) while neutralising any script execution,
 * external resource loading, or use of SVG features that can read or affect
 * the surrounding Portal document.
 *
 * Strategy:
 * 1. `scanForUnsafeContent` performs a fast rejection pass that catches the
 *    obvious dangerous patterns (script, event handlers, foreignObject, etc.).
 *    This is the gate used before persisting a freshly published artifact.
 * 2. `sanitizeSvgForInline` removes or escapes a stricter allowlist of tags and
 *    attributes so the rendered payload is safe even when served same-origin.
 *
 * Neither function tries to be a fully compliant HTML/SVG parser; together they
 * form a defense-in-depth layer that complements (does not replace) the
 * sandboxed iframe + CSP that the Portal viewer is required to use.
 */

const FORBIDDEN_TAGS = [
  "script",
  "foreignobject",
  "iframe",
  "use",
  "image",
  "audio",
  "video",
  "embed",
  "object",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "handler",
  "listener",
];

const FORBIDDEN_ATTR_PREFIXES = ["on", "data:", "xlink:href"];
const FORBIDDEN_ATTRS = ["href", "xlink:href", "style", "src", "formaction", "action"];

export interface SvgScanResult {
  safe: boolean;
  reason?: string;
}

export function scanForUnsafeContent(svg: string): SvgScanResult {
  if (!svg || typeof svg !== "string") {
    return { safe: false, reason: "empty payload" };
  }
  const lowered = svg.toLowerCase();

  for (const tag of FORBIDDEN_TAGS) {
    const open = new RegExp(`<\\s*${tag}(\\s|>|/)`, "i");
    if (open.test(svg)) {
      return { safe: false, reason: `forbidden tag: ${tag}` };
    }
  }

  const attrPattern = /\son[a-z]+\s*=|xlink:href\s*=|href\s*=|style\s*=|src\s*=|formaction\s*=|action\s*=|data:text\/html|javascript:/i;
  if (attrPattern.test(svg)) {
    const match = attrPattern.exec(svg);
    return { safe: false, reason: `forbidden attribute or protocol: ${match?.[0]}` };
  }

  const styleResult = scanStyleBlocks(svg);
  if (!styleResult.safe) return styleResult;

  if (lowered.includes("<![cdata[")) {
    return { safe: false, reason: "CDATA region" };
  }
  if (lowered.includes("<!--")) {
    return { safe: false, reason: "html comment" };
  }

  return { safe: true };
}

export function sanitizeSvgForInline(svg: string): string {
  if (!svg) return "";
  let cleaned = svg;
  for (const tag of FORBIDDEN_TAGS) {
    const open = new RegExp(`<\\s*${tag}\\b[^>]*>`, "gi");
    const close = new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
    cleaned = cleaned.replace(open, "").replace(close, "");
    const selfClosed = new RegExp(`<\\s*${tag}\\b[^>]*/\\s*>`, "gi");
    cleaned = cleaned.replace(selfClosed, "");
  }
  cleaned = cleaned.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  for (const attr of FORBIDDEN_ATTRS) {
    const attrRegex = new RegExp(`\\s${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi");
    cleaned = cleaned.replace(attrRegex, "");
  }
  for (const prefix of FORBIDDEN_ATTR_PREFIXES) {
    if (prefix === "on") continue;
    const prefixRegex = new RegExp(`\\s${escapeRegex(prefix)}[a-z0-9-]*\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi");
    cleaned = cleaned.replace(prefixRegex, "");
  }
  cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (block) => (
    scanStyleBlocks(block).safe ? block : ""
  ));
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  return cleaned.trim();
}

function scanStyleBlocks(svg: string): SvgScanResult {
  const completeBlocks = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let remainder = svg;
  let match: RegExpExecArray | null;
  while ((match = completeBlocks.exec(svg)) !== null) {
    const openingTag = match[0].slice(0, match[0].indexOf(">") + 1);
    if (!/^<style(?:\s+type\s*=\s*["']text\/css["'])?\s*>$/i.test(openingTag)) {
      return { safe: false, reason: "forbidden style attributes" };
    }
    const cssResult = scanStaticCss(match[1]);
    if (!cssResult.safe) return cssResult;
    remainder = remainder.replace(match[0], "");
  }
  if (/<\/?style\b/i.test(remainder)) {
    return { safe: false, reason: "malformed style block" };
  }
  return { safe: true };
}

function scanStaticCss(css: string): SvgScanResult {
  if (/[<>]/.test(css)) {
    return { safe: false, reason: "markup inside style block" };
  }
  // Reject CSS comments, escapes and XML/HTML entities. Browsers resolve
  // these before interpreting CSS, so accepting them would let a payload
  // disguise tokens such as `url` or `javascript` from the checks below.
  if (/\/\*|\\|&/.test(css)) {
    return { safe: false, reason: "CSS obfuscation token" };
  }
  const forbiddenCss = /@|javascript\s*:|data\s*:|expression\s*\(|behavior\s*:|-moz-binding\s*:/i;
  const forbiddenMatch = forbiddenCss.exec(css);
  if (forbiddenMatch) {
    return { safe: false, reason: `forbidden CSS token: ${forbiddenMatch[0]}` };
  }

  // SVG diagrams commonly reference their own markers and gradients with
  // url(#id). Keep those local references, but reject every URL that could
  // cause the browser to fetch or interpret external content.
  const withoutLocalFragments = css.replace(
    /url\s*\(\s*(["']?)#[A-Za-z_][A-Za-z0-9_.:-]*\1\s*\)/gi,
    "",
  );
  if (/url\s*\(/i.test(withoutLocalFragments)) {
    return { safe: false, reason: "external CSS URL" };
  }
  return { safe: true };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
