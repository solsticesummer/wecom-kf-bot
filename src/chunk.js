// Pure chunking functions — no I/O, no DB, no network — so they're trivially unit-testable.
// build-index.js calls these to turn a source document into retrieval-sized pieces.
//
// Design rule shared by both: split on *headings*, never on a token/character count. A
// fixed-size splitter would cut the 充值 pricing table or a permission table mid-row and
// corrupt the exact numbers the bot must quote verbatim.

/**
 * chunkFaq(markdown) → string[]
 * One chunk per top-level `## ` section of knowledge/faq.md, heading kept with its body.
 * Skips the leading `# H1` title and the `>` blockquote preamble (meta-instructions to the
 * author, not answerable knowledge). `###` and deeper stay inside their `##` section.
 */
export function chunkFaq(markdown) {
  const lines = markdown.split('\n');
  const chunks = [];
  let current = null; // null until we've seen the first `## ` heading

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) chunks.push(current.join('\n').trim());
      current = [line];          // start a new section, heading included
    } else if (current) {
      current.push(line);        // accumulate body until the next `## `
    }
    // Lines before the first `## ` (the H1 + blockquote preamble) fall through and are dropped.
  }
  if (current) chunks.push(current.join('\n').trim());

  return chunks.filter(Boolean);
}

// A chapter heading like `第九章：虾导、虾格、虾条` (Chinese-numeral chapter).
const CHAPTER_RE = /^第[〇零一二三四五六七八九十百千]+章[：:]\s*(.+)$/;
// A 小节 heading like `9.2 虾格：风格模板`. The `\d+\.\d+` guard is what separates a real
// sub-section from an ordinary numbered list item (`1. 进入…`, which is `\d+\.` only).
const SECTION_RE = /^(\d+\.\d+)\s+(.+)$/;

/**
 * chunkManual(text) → [{ section, content }]
 * `text` is `pdftotext -layout` output of the product manual. Emits one chunk per 小节,
 * tagged with its `第N章 / N.M 标题` heading path. Text between a chapter heading and its
 * first 小节 (the chapter intro) becomes its own chunk keyed by the chapter alone.
 */
export function chunkManual(text) {
  const lines = text.split('\n');
  const chunks = [];

  let chapter = '';           // e.g. "第九章：虾导、虾格、虾条"
  let heading = '';           // full path for the chunk currently being built
  let body = [];

  const flush = () => {
    const content = body.join('\n').trim();
    if (content) chunks.push({ section: heading.trim(), content });
    body = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const chap = line.match(CHAPTER_RE);
    const sect = line.match(SECTION_RE);

    if (chap) {
      flush();                               // close whatever came before
      chapter = line;
      heading = line;                        // chapter intro chunk keyed by chapter alone
    } else if (sect) {
      flush();                               // close the previous 小节 / chapter intro
      heading = chapter ? `${chapter} / ${line}` : line;
      body = [line];                         // keep the 小节 heading in the chunk
    } else {
      body.push(line);
    }
  }
  flush();

  return chunks;
}
