import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
