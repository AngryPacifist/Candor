import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, pool } from "./index.js";

async function main() {
  const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  await pool.query(schema);
  const res = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log(`migrated — tables: ${res.rows.map((r) => r.table_name).join(", ")}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
