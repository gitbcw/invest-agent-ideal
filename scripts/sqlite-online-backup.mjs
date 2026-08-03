import process from "node:process";

import Database from "better-sqlite3";

const [sourcePath, destinationPath] = process.argv.slice(2);

if (!sourcePath || !destinationPath) {
  console.error("usage: sqlite-online-backup.mjs <source> <destination>");
  process.exit(2);
}

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });

try {
  const sourceCheck = source.pragma("quick_check", { simple: true });
  if (sourceCheck !== "ok") throw new Error(`source quick_check failed: ${sourceCheck}`);

  await source.backup(destinationPath);

  const backup = new Database(destinationPath, { readonly: true, fileMustExist: true });
  try {
    const backupCheck = backup.pragma("quick_check", { simple: true });
    if (backupCheck !== "ok") throw new Error(`backup quick_check failed: ${backupCheck}`);
    const tables = backup.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count;
    console.log(JSON.stringify({ quickCheck: backupCheck, tables }));
  } finally {
    backup.close();
  }
} finally {
  source.close();
}
