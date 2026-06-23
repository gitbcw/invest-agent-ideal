/**
 * 复合指标编译缓存清理工具
 *
 * 清理 templates/workspace/cache/build/ 和实际工作空间 cache/build/ 下,
 * 超过 N 天未访问的 L3b 编译产物(<base>.<hash>.js)。
 *
 * 设计:只清 cache 子目录,绝不触碰 scripts/、reports/ 等业务数据。
 *
 * 用法:
 *   node scripts/clear-indicator-cache.mjs                 # 默认 30 天 + dry-run
 *   node scripts/clear-indicator-cache.mjs --apply         # 实际删除
 *   node scripts/clear-indicator-cache.mjs --days 7 --apply
 *   node scripts/clear-indicator-cache.mjs --path /custom/workspace
 *
 * 返回码:0=成功(包括无文件可删);1=参数错误或路径不存在
 */

import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

function parseArgs(argv) {
  const out = { days: 30, apply: false, paths: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--days") out.days = parseInt(argv[++i], 10);
    else if (a === "--path") out.paths.push(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(`用法: node scripts/clear-indicator-cache.mjs [--days N] [--apply] [--path DIR]
  --days N    清理 N 天未访问的文件(默认 30)
  --apply     实际删除;不带此参数为 dry-run
  --path DIR  追加要扫描的工作空间路径(可多次)`);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (Number.isNaN(out.days) || out.days < 1) {
    console.error(`--days must be a positive integer`);
    process.exit(1);
  }
  return out;
}

function findCacheDirs(extraPaths) {
  const dirs = [];
  // 默认:模板的 cache/build
  const tmpl = resolve("./templates/workspace/cache/build");
  if (existsSync(tmpl)) dirs.push(tmpl);
  // 用户工作空间(单客户 MVP 阶段假设 ./workspace)
  const userWs = resolve("./workspace/cache/build");
  if (existsSync(userWs)) dirs.push(userWs);
  // 命令行 --path
  for (const p of extraPaths) {
    const cacheDir = join(resolve(p), "cache", "build");
    if (existsSync(cacheDir)) dirs.push(cacheDir);
    else console.warn(`[warn] --path 指定的 cache 不存在,跳过: ${cacheDir}`);
  }
  return dirs;
}

function sweepDir(cacheDir, daysThreshold, apply) {
  const now = Date.now();
  const thresholdMs = daysThreshold * 24 * 60 * 60 * 1000;
  let total = 0;
  let stale = 0;
  let bytes = 0;

  const entries = readdirSync(cacheDir);
  for (const name of entries) {
    if (name === ".gitkeep") continue;
    if (!name.endsWith(".js")) continue;
    total++;
    const full = join(cacheDir, name);
    const st = statSync(full);
    const atime = st.atimeMs;
    if (now - atime > thresholdMs) {
      stale++;
      bytes += st.size;
      if (apply) {
        unlinkSync(full);
        console.log(`[deleted] ${full} (last access ${new Date(atime).toISOString().slice(0, 10)})`);
      } else {
        console.log(`[dry-run] ${full} (last access ${new Date(atime).toISOString().slice(0, 10)})`);
      }
    }
  }
  return { total, stale, bytes };
}

const args = parseArgs(process.argv);
const dirs = findCacheDirs(args.paths);

if (dirs.length === 0) {
  console.log("[skip] 未找到任何 cache/build 目录,无需清理");
  process.exit(0);
}

console.log(`[mode] ${args.apply ? "APPLY" : "DRY-RUN"} threshold=${args.days}天`);
console.log(`[scan] ${dirs.length} 个 cache 目录`);

let totalAll = 0;
let staleAll = 0;
let bytesAll = 0;
for (const dir of dirs) {
  console.log(`\n--- ${dir} ---`);
  const r = sweepDir(dir, args.days, args.apply);
  console.log(`  扫描 ${r.total} 个 .js,${r.stale} 个超期,共 ${(r.bytes / 1024).toFixed(1)} KB`);
  totalAll += r.total;
  staleAll += r.stale;
  bytesAll += r.bytes;
}

console.log(
  `\n[summary] 扫描 ${totalAll} 个文件,${staleAll} 个超期(${(bytesAll / 1024).toFixed(1)} KB)` +
    (args.apply ? "" : "  (dry-run,如需实际删除请加 --apply)"),
);
