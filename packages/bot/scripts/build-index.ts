// Ingest every knowledge source into the `chunks` table.
// Usage: npm run index   (needs DATABASE_URL + a Model Studio key for embeddings)
//
// Each source is reloaded in its own transaction (DELETE WHERE source=$1; INSERT …), so
// re-indexing one corpus never disturbs the others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/db.js';
import { embed, toVectorLiteral } from '../src/retrieval.js';
import { chunkFaq, chunkManual } from '../src/chunk.js';

type Pool = ReturnType<typeof getPool>;

interface SourceChunk {
  source: string;
  section: string;
  content: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_DIR = process.env.KB_SOURCE_DIR || path.join(os.homedir(), 'Downloads');

// --- Source → SourceChunk[] ------------------------------------------------------------

function faqChunks(): SourceChunk[] {
  const md = fs.readFileSync(path.join(ROOT, 'knowledge', 'faq.md'), 'utf8');
  return chunkFaq(md).map((content) => ({
    source: 'faq.md',
    section: content.split('\n')[0].replace(/^#+\s*/, ''), // the ## heading
    content,
  }));
}

function manualChunks(): SourceChunk[] {
  const pdf = path.join(SRC_DIR, 'DramaClaw 产品使用手册.pdf');
  if (!fs.existsSync(pdf)) {
    console.warn('manual not found, skipping:', pdf);
    return [];
  }
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return chunkManual(text).map((c) => ({ source: 'manual', section: c.section, content: c.content }));
}

function whitepaperChunks(): SourceChunk[] {
  const pptx = path.join(SRC_DIR, 'DramaClaw产品白皮书_0624版(1).pptx');
  if (!fs.existsSync(pptx)) {
    console.warn('whitepaper not found, skipping:', pptx);
    return [];
  }
  const json = execFileSync('python3', [path.join(__dirname, 'extract-pptx.py'), pptx], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(json) as { index: number; title: string; text: string }[])
    .filter((s) => s.text && s.text.trim())
    .map((s) => ({
      source: 'whitepaper',
      section: s.title || `slide ${s.index + 1}`,
      content: (s.title ? `${s.title}\n` : '') + s.text,
    }));
}

// --- Embed + reload one source in a transaction ----------------------------------------

async function reloadSource(
  pool: Pool,
  namespace: string,
  source: string,
  chunks: SourceChunk[],
): Promise<void> {
  if (chunks.length === 0) {
    console.log(`${namespace}/${source}: 0 chunks (skipped)`);
    return;
  }
  process.stdout.write(`${namespace}/${source}: embedding ${chunks.length} chunks`);
  const vectors: number[][] = [];
  for (const c of chunks) {
    vectors.push(await embed(c.content)); // sequential: stays well under rate limits
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Both keys in the DELETE. Scoping it to `source` alone would clear that document
    // across EVERY namespace — re-indexing one tenant's faq.md would silently wipe the next
    // tenant's, and the bot would only degrade at the next customer question.
    await client.query('DELETE FROM chunks WHERE namespace = $1 AND source = $2', [namespace, source]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        'INSERT INTO chunks (namespace, source, section, content, embedding) VALUES ($1,$2,$3,$4,$5::vector)',
        [namespace, source, chunks[i].section, chunks[i].content, toVectorLiteral(vectors[i])],
      );
    }
    await client.query('COMMIT');
    console.log(`${namespace}/${source}: reloaded ${chunks.length} chunks`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Which namespace this run writes into — must match what retrieval.ts reads (Stage B moves
// both onto the tenant config so they can't drift apart).
const NAMESPACE = process.env.KB_NAMESPACE || 'dramaclaw';

try {
  const pool = getPool();
  await reloadSource(pool, NAMESPACE, 'faq.md', faqChunks());
  await reloadSource(pool, NAMESPACE, 'manual', manualChunks());
  await reloadSource(pool, NAMESPACE, 'whitepaper', whitepaperChunks());
  console.log('index: done');
} catch (err) {
  console.error('index failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
