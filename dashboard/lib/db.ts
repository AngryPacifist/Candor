import { Pool } from "pg";

// In production this connects through a read-only Postgres role; the
// dashboard never writes.
const globalForPg = globalThis as unknown as { candorPool?: Pool };

export const pool =
  globalForPg.candorPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

if (!globalForPg.candorPool) globalForPg.candorPool = pool;
