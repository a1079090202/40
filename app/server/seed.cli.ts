import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb, getDbPath, migrate } from "./db";
import { seed } from "./seed";

const file = process.env.DATABASE_PATH ?? getDbPath();
if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
const db = createDb(file);
migrate(db);
seed(db);
db.close();
console.log(`种子数据已写入 ${file}`);
