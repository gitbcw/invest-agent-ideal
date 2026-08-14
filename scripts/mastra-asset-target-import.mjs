#!/usr/bin/env node

/** Copy a generic asset mapping into an isolated project and ledger. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const args = parseArgs(process.argv.slice(2));
const mappingPath = requiredAbsolute(args.mapping, "--mapping");
const targetDbPath = requiredAbsolute(args.targetDb, "--target-db");
const targetProjectRoot = requiredAbsolute(args.targetProjectRoot, "--target-project-root");
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const batchId = requiredId(args.batchId, "--batch-id");
const projectId = args.projectId ? requiredId(args.projectId, "--project-id") : "invest-agent";
await assertFile(mappingPath, "asset mapping");
await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertOutsideSnapshot(targetDbPath, snapshotRoot, "--target-db");
await assertOutsideSnapshot(targetProjectRoot, snapshotRoot, "--target-project-root");
await mkdir(path.dirname(targetDbPath), { recursive: true, mode: 0o700 });
await mkdir(targetProjectRoot, { recursive: true, mode: 0o700 });
const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
const source = mapping?.source;
if (mapping?.mode !== "dry_run" || !source?.workspaceId || !source?.userId || !source?.instanceId || !Array.isArray(mapping.entries)) throw new Error("mapping must be an asset dry-run report");
const files = [];
for (const entry of mapping.entries) {
  const sourcePath = path.join(snapshotRoot, source.workspaceId, entry.sourcePath);
  await assertFile(sourcePath, entry.sourcePath);
  const bytes = await readFile(sourcePath);
  if (sha256(bytes) !== entry.sha256) throw new Error(`MASTRA_ASSET_SOURCE_CHANGED: ${entry.sourcePath}`);
  files.push({ ...entry, bytes, targetPath: `assets/migrated/${entry.sourcePath}` });
}
const db = new Database(targetDbPath);
try {
  db.exec(`CREATE TABLE IF NOT EXISTS mastra_workspace_asset_records (record_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,instance_id TEXT NOT NULL,source_path TEXT NOT NULL,disposition TEXT NOT NULL,retention_class TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,checksum TEXT NOT NULL,target_path TEXT NOT NULL,executable INTEGER NOT NULL DEFAULT 0,migration_batch_id TEXT NOT NULL,created_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS idx_mastra_workspace_asset_scope_path ON mastra_workspace_asset_records(user_id,project_id,instance_id,source_path,checksum);`);
  const existing = db.prepare("SELECT record_id AS recordId,source_path AS sourcePath,checksum,target_path AS targetPath,disposition,retention_class AS retentionClass FROM mastra_workspace_asset_records WHERE user_id=? AND project_id=? AND instance_id=?").all(source.userId, projectId, source.instanceId);
  const existingByPath = new Map(existing.map((row) => [row.sourcePath, row]));
  for (const file of files) { const row = existingByPath.get(file.sourcePath); if (row && (row.checksum !== file.sha256 || row.targetPath !== file.targetPath || row.disposition !== file.disposition || row.retentionClass !== file.retentionClass)) throw new Error(`MASTRA_ASSET_IMPORT_CONFLICT: ${file.sourcePath}`); const targetBytes = await readOptional(path.join(targetProjectRoot, file.targetPath)); if (row && !targetBytes?.equals(file.bytes)) throw new Error(`MASTRA_ASSET_IMPORT_CONFLICT: bytes/${file.sourcePath}`); }
  if (existing.length > 0 && existing.length !== files.length) throw new Error("MASTRA_ASSET_IMPORT_CONFLICT: target count differs");
  if (existing.length === files.length) { console.log(JSON.stringify({ ok: true, mode: "target_import", action: "replayed", batchId, scope: { userId: source.userId, projectId, instanceId: source.instanceId }, recordCount: files.length, codeExecutionEnabled: false }, null, 2)); }
  else {
    const now = new Date().toISOString(); const written=[];
    try { for (const file of files) { const target=path.join(targetProjectRoot,file.targetPath); await mkdir(path.dirname(target),{recursive:true,mode:0o700}); await writeFile(target,file.bytes,{flag:"wx",mode:0o600}); written.push(target); } db.transaction(()=>{ for(const file of files){const id=`asset-record:${sha256(`${source.userId}\0${projectId}\0${source.instanceId}\0${file.sourcePath}\0${file.sha256}`)}`; db.prepare("INSERT INTO mastra_workspace_asset_records (record_id,user_id,project_id,instance_id,source_path,disposition,retention_class,mime_type,size_bytes,checksum,target_path,executable,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,source.userId,projectId,source.instanceId,file.sourcePath,file.disposition,file.retentionClass,file.mimeType,file.sizeBytes,file.sha256,file.targetPath,0,batchId,now); }})(); } catch(error){for(const target of written) await unlink(target).catch(()=>undefined); throw error;} console.log(JSON.stringify({ok:true,mode:"target_import",action:"inserted",batchId,scope:{userId:source.userId,projectId,instanceId:source.instanceId},recordCount:files.length,codeExecutionEnabled:false},null,2)); }
} finally { db.close(); }
function sha256(value){return createHash("sha256").update(value).digest("hex");}
function requiredAbsolute(value,flag){if(!value||!path.isAbsolute(value))throw new Error(`${flag} must be an absolute path`);return path.resolve(value);}
function requiredId(value,flag){if(!value||/[\\/\0]/.test(value))throw new Error(`${flag} must be a safe identifier`);return value;}
async function assertFile(value,label){const info=await lstat(value).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink())throw new Error(`${label} must be a regular file`);}
async function assertDirectory(value,label){const info=await lstat(value).catch(()=>null);if(!info?.isDirectory()||info.isSymbolicLink())throw new Error(`${label} must be a non-symlink directory`);}
async function readOptional(value){try{return await readFile(value);}catch(error){if(error?.code==="ENOENT")return null;throw error;}}
async function assertOutsideSnapshot(target,root,flag){const canonicalRoot=await realpath(root);const candidate=await canonicalFuturePath(target);const relative=path.relative(canonicalRoot,candidate);if(relative===""||(!relative.startsWith(`..${path.sep}`)&&relative!==".."&&!path.isAbsolute(relative)))throw new Error(`${flag} must be outside the workspace snapshot source`);}
async function canonicalFuturePath(target){const tail=[];let current=target;while(true){try{return path.join(await realpath(current),...tail.reverse());}catch(error){if(error?.code!=="ENOENT")throw error;const parent=path.dirname(current);if(parent===current)throw error;tail.push(path.basename(current));current=parent;}}}
function parseArgs(argv){const values={};for(let index=0;index<argv.length;index+=1){const key=argv[index];if(["--mapping","--target-db","--target-project-root","--workspace-snapshot","--batch-id","--project-id"].includes(key))values[key.slice(2).replace(/-([a-z])/g,(_,char)=>char.toUpperCase())]=argv[++index];}return values;}
