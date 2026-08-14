import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { getConfig } from "@/lib/config";
import { initializeSchema } from "./schema";

let instance: Database.Database | null = null;

/**
 * 打开 SQLite 数据库并初始化 schema。开发模式下首次运行会自动创建 data/ 目录。
 */
export function openDatabase(): Database.Database {
  if (instance) return instance;
  const cfg = getConfig();
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const db = new Database(cfg.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);
  instance = db;
  return db;
}

/**
 * 测试或脚本场景下使用独立数据库。
 */
export function openDatabaseAt(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);
  return db;
}

/**
 * 主要给单元测试用,关闭当前数据库实例。
 */
export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
