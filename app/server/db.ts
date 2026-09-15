import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadSchema(): string {
  // 开发/tsx 下与模块同目录；remix 构建后模块在 build/server，回退到源码目录
  const candidates = [join(HERE, "schema.sql"), join(process.cwd(), "app", "server", "schema.sql")];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`找不到 schema.sql，尝试过：${candidates.join(", ")}`);
  return readFileSync(found, "utf8");
}

let db: Database.Database | null = null;

export function getDbPath(): string {
  return process.env.DATABASE_PATH ?? join(process.cwd(), "data", "arena.db");
}

export function createDb(file: string = ":memory:"): Database.Database {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  return d;
}

export function migrate(d: Database.Database): void {
  d.exec(loadSchema());
}

/** 进程内单例（Remix dev / serve 使用） */
export function getDb(): Database.Database {
  if (db) return db;
  const path = getDbPath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = createDb(path);
  migrate(db);
  return db;
}

export type DB = Database.Database;
