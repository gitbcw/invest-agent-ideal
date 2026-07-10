import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const sdkPath = path.resolve("node_modules/weixin-agent-sdk/dist/index.mjs");
const sdkTypesPath = path.resolve("node_modules/weixin-agent-sdk/dist/index.d.mts");

if (!existsSync(sdkPath)) {
  console.warn("[patch-weixin-agent-sdk] skip: weixin-agent-sdk dist not found");
  process.exit(0);
}

let changed = false;
let source = readFileSync(sdkPath, "utf-8");

const markdownPatched = source.replace(
  /function markdownToPlainText\(text\) \{\n[\s\S]*?\n\}/,
  "function markdownToPlainText(text) {\n\treturn text;\n}"
);

if (markdownPatched !== source) {
  source = markdownPatched;
  changed = true;
}

const requestPatched = source.replace(
  /const request = \{\n\t\tconversationId: full\.from_user_id \?\? "",\n\t\ttext: bodyFromItemList\(full\.item_list\),\n\t\tmedia\n\t\};/,
  "const request = {\n\t\tconversationId: full.from_user_id ?? \"\",\n\t\ttext: bodyFromItemList(full.item_list),\n\t\tcontextToken,\n\t\tmedia\n\t};"
);

if (requestPatched !== source) {
  source = requestPatched;
  changed = true;
}

if (changed) {
  writeFileSync(sdkPath, source, "utf-8");
}

let typeChanged = false;
if (existsSync(sdkTypesPath)) {
  let types = readFileSync(sdkTypesPath, "utf-8");
  if (!types.includes("contextToken?: string")) {
    const typePatched = types.replace(
      /(\s+\/\*\* Text content of the message\. \*\/\n\s+text: string;)/,
      "$1\n  /** Weixin per-message context token. Echo it on outbound sends when available. */\n  contextToken?: string;"
    );
    if (typePatched !== types) {
      types = typePatched;
      typeChanged = true;
      writeFileSync(sdkTypesPath, types, "utf-8");
    }
  }
}

if (!changed && !typeChanged) {
  if (
    /function markdownToPlainText\(text\) \{\n\treturn text;\n\}/.test(source) &&
    /contextToken,\n\t\tmedia/.test(source)
  ) {
    console.log("[patch-weixin-agent-sdk] already patched");
    process.exit(0);
  }
  console.warn("[patch-weixin-agent-sdk] markdownToPlainText signature not found");
  process.exit(0);
}

console.log("[patch-weixin-agent-sdk] patched markdown passthrough and contextToken passthrough");
