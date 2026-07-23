# CLAUDE.md — wecom-kf-bot

AI auto-reply bot for a WeCom (企业微信) 微信客服 account, product **DramaClaw**.
Customers message the kf account in WeChat; the bot answers with **Qwen (Aliyun
DashScope)** grounded in a knowledge base, and hands off to a human when it can't
help, is asked to, or a bug is reported. **Has live customers** — every change must
keep the production invariants below working.

## Language & tooling
- **TypeScript**, native ESM (`"type": "module"`), `moduleResolution: NodeNext`
  (so import specifiers keep the `.js` extension even for `.ts` files).
- `strict: true`, with `useUnknownInCatchVariables: false` (the ~20
  `catch (err) { …err.message }` sites; tightening to `err instanceof Error` is
  deferred tech-debt).
- Build: `npm run build` (tsc → `dist/`); prod runs `node dist/src/server.js`.
  Dev/tests/scripts run via **tsx** (no compile): `npm run dev`, `npm test`.
- Tests: `node:test` + `node:assert/strict`, run with `node --import tsx --test`.

## Architecture direction (decided 2026-07-23)
Turning this single bot into a reusable **MCP + agent + skill framework**. Full
plan: `~/.claude/plans/you-are-planning-jolly-stonebraker.md`. Key decisions:
- **Language split along the MCP seam:** TypeScript for the bot / agent / channel /
  tenant layer; **Python** for the knowledge + MCP layer (retrieval, ingestion,
  search server, and a future Cognee evaluation).
- **Cognee:** skip for production for now; keep the `kb_search`/`kb_ingest` MCP
  interface so it can mount later as a second backend. Trial it on the dev machine
  first for cross-project search.
- **Python knowledge layer is proven as a local dev tool first**; the live bot keeps
  its current in-process TS retrieval until the Python service earns the cutover
  (full-FAQ fallback stays on the TS side, preserving the "retrieval outage is never
  customer-visible" invariant).

## Source map (`src/`)
- `server.ts` — Express: WeCom callback (decrypt → ack <5s → process async), the
  message pipeline (dedupe, safety allowlist, rate limit, ownership check, 转人工
  menu, reply, logging), SIGTERM drain.
- `ai.ts` — one Qwen call that answers AND triages → `{ action, reply, bugSummary,
  handoffReason, usage }`. Uses `prompt.ts` + `http.ts`; degrades to a handoff on
  API/parse failure.
- `prompt.ts` — the CS triage system prompt as a template with tenant slots
  (`buildSystemRules(DRAMACLAW)`). Locked byte-identical by
  `test/prompt.test.ts` against `test/fixtures/dramaclaw-system-rules.txt`.
- `http.ts` — shared retry/backoff JSON POST client (used by ai + retrieval).
- `retrieval.ts` — hybrid recall (pgvector dense ∪ pg_trgm) → qwen3-rerank →
  cosine-dedup. Throws on failure so `ai.ts` can fall back to the full FAQ.
- `chunk.ts` — heading-aware chunking (never splits a pricing table row).
- `state.ts` — JSON-file persistence (cursor, msgid dedupe, history, bugs,
  unanswered, usage, pending tips). `crypto.ts` / `wecom.ts` — WeCom protocol.
- `db.ts` — lazy pg pool. `ratelimit.ts` — in-memory per-customer sliding window.

## Invariants that must keep working
ACK-then-process (200 within ~5s); `ALLOWED_KF_IDS` safety allowlist (fail-closed);
service-state ownership check (never talk over staff); per-customer rate limit;
msgid dedupe; bug / coverage-gap logging; retrieval failure degrades to full-FAQ,
never a customer-visible outage.

## Session log
- **2026-07-23** — Planned the framework restructure (plan file above). Executed
  **Phase 1 in TypeScript**: big-bang JS→TS conversion of the whole Node codebase
  (tsconfig, tsx, `dist/` build); extracted the duplicated retry/backoff into
  `http.ts`; extracted the DramaClaw system prompt into `prompt.ts` behind a
  golden-fixture regression test. Fixed a real contract bug the types surfaced
  (`addUnanswered` callers omit `reason`). Verified: `npm run typecheck` clean,
  `npm test` 38 pass / 1 DB-gated skip (incl. the byte-identical prompt lock), and a
  live end-to-end call (retrieval + Qwen through `http.ts`) returned a correctly
  grounded answer. Updated README/SETUP deploy commands for the build step.
  Branch: `refactor/phase1-extract-core`. Reviewed after: added `tsconfig.build.json`
  so the prod build emits only `src/` (not tests/scripts).
- **2026-07-23 — Phase 2: Python knowledge + MCP layer** (`packages/knowledge/`, same
  branch). Brought Python forward (the TS bot is untouched — zero prod risk). A
  runnable **MCP server** + CLI that chunks, embeds (DashScope text-embedding-v4),
  and hybrid-searches (dense ∪ trigram, RRF-fused) arbitrary project corpora by
  **`namespace`** — the cross-project "search engine," and the reference schema the
  bot's `chunks` table will later adopt. Tools: `kb_search` / `kb_ingest` /
  `kb_list_namespaces` / `kb_delete_namespace`. Runs against a **dedicated**
  `knowledge_dev` Postgres (never the bot's DB). Verified end-to-end: chunk unit
  tests pass, MCP lists 4 tools, real ingest (19 chunks) + semantic search returns
  correct modules. Install note: use `pip install -e . --config-settings
  editable_mode=compat` (strict editable's `.pth` finder didn't auto-load here).
  **Deferred:** moving the TS bot into `packages/bot/` (pure bookkeeping — low value
  until more packages exist). **Next:** rerank pass + PDF/PPTX connectors in Python;
  add the `namespace` column to the bot's own `chunks` table; then wire the bot to
  this service (behind the full-FAQ fallback) when it earns the cutover.
