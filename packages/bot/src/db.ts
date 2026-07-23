// Lazy singleton Postgres pool. Created on first use, NOT at import time, so
// modules can import this without forcing a DB connection — the demo/REPL and the
// pure unit tests must still load `ai.ts`/`retrieval.ts` even with no DATABASE_URL.
//
// `pg` is CommonJS; with esModuleInterop we default-import and destructure Pool off it.
import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

// Returns the shared pool, throwing a clear error if the app was started without
// a DATABASE_URL. Callers (retrieval) treat a throw here as a retrieval failure
// and fall back to the full FAQ — see src/ai.ts.
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    // Small pool: this is a single-instance support bot, not a high-QPS API.
    pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  }
  return pool;
}

// Thin convenience wrapper so call sites read `query(sql, params)`.
export function query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  return getPool().query(text, params as any[]);
}

// For scripts/tests that want a clean shutdown (otherwise the process hangs on
// the open pool). No-op if the pool was never created.
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
