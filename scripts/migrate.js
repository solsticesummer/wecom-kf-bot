// Applies db/schema.sql to the database in DATABASE_URL.
// Idempotent (every statement is CREATE ... IF NOT EXISTS), so it's safe to re-run.
// Usage: npm run migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');

try {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await getPool().query(sql);
  console.log('migrate: applied db/schema.sql');
} catch (err) {
  console.error('migrate failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
