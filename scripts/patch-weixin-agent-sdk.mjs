import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const sdkPath = path.resolve("node_modules/weixin-agent-sdk/dist/index.mjs");

if (!existsSync(sdkPath)) {
  console.warn("[patch-weixin-agent-sdk] skip: weixin-agent-sdk dist not found");
  process.exit(0);
}

const source = readFileSync(sdkPath, "utf-8");
const patched = source.replace(
  /function markdownToPlainText\(text\) \{\n[\s\S]*?\n\}/,
  "function markdownToPlainText(text) {\n\treturn text;\n}"
);

if (patched === source) {
  if (/function markdownToPlainText\(text\) \{\n\treturn text;\n\}/.test(source)) {
    console.log("[patch-weixin-agent-sdk] already patched");
    process.exit(0);
  }
  console.warn("[patch-weixin-agent-sdk] markdownToPlainText signature not found");
  process.exit(0);
}

writeFileSync(sdkPath, patched, "utf-8");
console.log("[patch-weixin-agent-sdk] patched markdownToPlainText passthrough");
