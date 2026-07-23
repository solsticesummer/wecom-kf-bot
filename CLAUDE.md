# CLAUDE.md — wecom-kf-bot (monorepo)

> **Handoff doc.** Read this top-to-bottom to resume in a fresh session. It holds
> the current status, how to run everything, the roadmap, and the decisions +
> rationale behind the restructure in progress.

## TL;DR
An AI auto-reply bot for a WeCom (企业微信) 微信客服 account, product **DramaClaw**
(Qwen / Aliyun DashScope, grounded in a knowledge base, human handoff). **It has
live customers** — keep the invariants below intact. We are turning it from one
single-purpose bot into a reusable **MCP + agent + skill framework** (multi-tenant,
cross-project search). Work is on branch **`refactor/phase1-extract-core`** (pushed,
**not merged** — open a PR when ready). Full architecture plan lives at
`~/.claude/plans/you-are-planning-jolly-stonebraker.md` (persists on this machine).

## Status
- [x] **Phase 1** — big-bang JS→TS conversion of the whole Node bot; extracted the
  shared retry client (`http.ts`) and the tenant-templated system prompt (`prompt.ts`,
  golden-fixture locked).
- [x] **Phase 1 review** — `tsconfig.build.json` so prod build emits only `src/`.
- [x] **Phase 2** — Python knowledge + MCP layer (`packages/knowledge/`): chunk /
  embed / hybrid-search any project by `namespace`; MCP server + CLI. Proven as a
  local dev tool.
- [x] **Monorepo reorg** — bot moved to `packages/bot/`; npm-workspace root; fixed a
  latent compiled-FAQ-fallback bug (build now copies `knowledge/` → `dist/`).
- [ ] **Next (not started):** see **Roadmap**. Immediate candidates: rerank +
  PDF/PPTX connectors in the Python layer; add a `namespace` column to the *bot's*
  `chunks` table; then the skill system.

## How to resume — run things

**Repo layout (npm workspaces):**
```
wecom-kf-bot/
├─ package.json            private workspace root; scripts delegate to the bot
├─ packages/
│  ├─ bot/                 the TypeScript WeCom bot  (src, scripts, test, knowledge/faq.md, db, .env)
│  └─ knowledge/           the Python knowledge + MCP layer  (NOT an npm workspace)
├─ README.md  SETUP.md  CLAUDE.md
```

**Bot (TypeScript)** — run from the repo root (root scripts delegate to `packages/bot`):
- `npm install` — installs the workspace.
- `npm test` — `node --import tsx --test` (38 pass, 1 DB-gated skip).
- `npm run typecheck` / `npm run dev` (tsx, no compile) / `npm run build` (tsc →
  `dist/`, then copies `knowledge/` into `dist/`).
- Prod: `npm run build`, then `cd packages/bot && pm2 start dist/src/server.js` (cwd
  must be `packages/bot` so `./data/` and the FAQ resolve).
- Ops: `npm run migrate | index | list-kf | demo | chat`.
- Env: `packages/bot/.env` (real secrets, gitignored). Bot uses Postgres DB **`wecom`**
  (pg17 + pgvector) for retrieval; degrades to the full FAQ if the DB/embeddings are down.
  Key split: chat uses `DASHSCOPE_API_KEY` (sk-…); embeddings/rerank use
  `MODELSTUDIO_API_KEY` (sk-ws-…). `ALLOWED_KF_IDS` = the safety allowlist.

**Knowledge layer (Python)** — from `packages/knowledge/`:
- Setup: `python3 -m venv .venv && . .venv/bin/activate && pip install -e .
  --config-settings editable_mode=compat` (compat mode is required here — the strict
  editable `.pth` finder didn't auto-load on this Mac). Venv already exists at
  `packages/knowledge/.venv`.
- Env: `KNOWLEDGE_DATABASE_URL=postgresql:///knowledge_dev` (a **dedicated** DB, never
  the bot's) + `MODELSTUDIO_API_KEY`. `createdb knowledge_dev` if missing.
- CLI: `knowledge ingest <ns> <path>` · `knowledge search <ns> "<q>"` · `knowledge namespaces`.
- MCP server (stdio): `knowledge-mcp` — point an MCP client (Claude Code) at it.
- Tests (no infra): `python tests/test_chunk.py`.
- Set `KNOWLEDGE_EMBEDDER=fake` for offline (non-semantic) runs.

## Language & tooling (bot)
- **TypeScript**, native ESM (`"type": "module"`), `moduleResolution: NodeNext` (import
  specifiers keep the `.js` extension even for `.ts`). `strict: true` with
  `useUnknownInCatchVariables: false` (the ~20 `catch (err) { …err.message }` sites;
  tightening to `err instanceof Error` is deferred tech-debt).
- Build config split: `tsconfig.json` typechecks src+scripts+test; `tsconfig.build.json`
  emits only `src/` → `dist/`.

## Architecture decisions (the "why")
- **Language split along the MCP seam:** TypeScript for the bot / agent / channel /
  tenant layer; **Python** for the knowledge + MCP layer. The natural language boundary
  and the natural architectural boundary are the same line.
- **Knowledge is a library first, MCP server second:** the bot will call it in-process
  on the hot path (sub-second, preserves the full-FAQ degradation invariant); the MCP
  server is for *foreign* consumers (Claude Code locally, hosted services). An IPC hop
  on every customer message would add a failure mode to a path that must never produce a
  customer-visible outage.
- **Python knowledge proven as a dev tool first**, then the live bot cuts over once it
  earns it (full-FAQ fallback stays on the TS side).
- **Cognee: skip for production now, keep the `kb_search`/`kb_ingest` interface** so it
  can mount later as a second (graph/memory) backend; trial it locally first. Reasons it
  loses for *this* workload: cognify's LLM extraction rewrites content (the bot must quote
  pricing tables verbatim), nondeterministic + token-costly indexing, China-network
  friction (defaults to OpenAI), and a Python-datastore ops burden.
- **Tenancy:** a tenant is a config file; `open_kfid` is the natural tenant key on WeCom
  (the enterprise-wide callback already forces routing by kf account, and `ALLOWED_KF_IDS`
  generalizes to "registered tenants only"). Productization (tenants in Postgres, auth,
  quotas) is a designed-for later horizon, not built yet.

**User's scoping answers (this project):** many/productized tenants *eventually*, but
build config-driven multi-tenancy now; **WeCom is the only channel for now** (carve a
clean channel-adapter seam, don't build a 2nd channel speculatively); a Python sidecar is
acceptable and cost matters (no server bought yet); cross-project search needed **both**
locally and hosted; **big-bang** TS migration (done); complete the monorepo (done).

## Roadmap (remaining, roughly in order — each step must keep the bot green)
1. **Python knowledge polish:** add a `qwen3-rerank` pass behind `search.py`; PDF/PPTX
   connectors (mirror the bot's `build-index` sources). Trial the MCP server against a
   genuinely different project.
2. **Namespace the bot's own retrieval:** add a `namespace` column to `packages/bot/db/
   schema.sql` + `retrieval.ts` recall CTEs + `build-index.ts` (default `'dramaclaw'`
   backfills existing rows). This aligns the bot's store with the Python reference schema.
3. **Skill system:** define `skill.yaml` / `prompt.md` / `actions.json`; port the triage
   prompt into a generic `cs-triage` skill with DramaClaw specifics (product name, terms,
   copy, the `account`/credits-tip flow) moved to a `tenants/dramaclaw.yaml`. Replace the
   `if (action === …)` chain in `server.ts` with an action-handler registry. Guard with a
   byte-identical composed-prompt snapshot.
4. **Tenant registry:** route by `open_kfid` (fail-closed, subsuming `ALLOWED_KF_IDS`);
   per-tenant state dir / rate-limit keys / usage / admin endpoints. Onboard a toy tenant #2.
5. **Cut the bot over** to the Python knowledge service (behind the full-FAQ fallback) once
   it's proven; optionally mount Cognee as a 2nd MCP backend for graph/cross-project search.
6. **Later horizon:** tool-use execution mode for non-CS skills; productization.

**Deferred on purpose:** nothing pressing. (The bot→`packages/bot` move is done.)

## Open items / risks
- Branch `refactor/phase1-extract-core` is unmerged — open a PR / merge when ready.
- Prompt-regression is the top risk for the skill work (Phase 3) — keep the golden
  snapshot + a small golden-question eval from `/unanswered?reason=not_in_kb`.
- Multi-**corp** tenancy (different companies, not just kf accounts) needs per-tenant WeCom
  credentials — supported by the registry design; don't build until tenant #2 needs it.
- Embeddings are DashScope-coupled (re-embedding to switch is costly) — accepted for now.

## Source map (`packages/bot/src/`)
- `server.ts` — Express: WeCom callback (decrypt → ack <5s → process async), the message
  pipeline (dedupe, `ALLOWED_KF_IDS` allowlist, rate limit, service-state ownership check,
  转人工 menu, reply, logging), SIGTERM drain.
- `ai.ts` — one Qwen call that answers AND triages → `{ action, reply, bugSummary,
  handoffReason, usage }`. Uses `prompt.ts` + `http.ts`; degrades to a handoff on
  API/parse failure; inlines the full FAQ if retrieval fails.
- `prompt.ts` — CS triage prompt as a tenant template (`buildSystemRules(DRAMACLAW)`);
  byte-identical lock in `test/prompt.test.ts` vs `test/fixtures/dramaclaw-system-rules.txt`.
- `http.ts` — shared retry/backoff JSON POST client (ai + retrieval).
- `retrieval.ts` — hybrid recall (pgvector dense ∪ pg_trgm) → qwen3-rerank → cosine-dedup;
  throws on failure so `ai.ts` falls back to the full FAQ.
- `chunk.ts` — heading-aware chunking (never splits a pricing-table row).
- `state.ts` — JSON-file persistence (cursor, msgid dedupe, history, bugs, unanswered,
  usage, pending tips). `crypto.ts` / `wecom.ts` — WeCom protocol.
- `db.ts` — lazy pg pool. `ratelimit.ts` — in-memory per-customer sliding window.

## Python knowledge layer map (`packages/knowledge/knowledge/`)
`chunk.py` (heading-aware md + line-window fallback) · `embed.py` (DashScope
text-embedding-v4; deterministic `fake` backend) · `store.py` (Postgres+pgvector,
first-class `namespace` column — the reference schema the bot will adopt) · `search.py`
(dense ∪ trigram, RRF-fused; rerank slot open) · `connectors.py` (walk a folder) ·
`ingest.py` · `server.py` (MCP: `kb_search`/`kb_ingest`/`kb_list_namespaces`/
`kb_delete_namespace`) · `cli.py`.

## Invariants that must keep working
ACK-then-process (200 within ~5s); `ALLOWED_KF_IDS` safety allowlist (fail-closed);
service-state ownership check (never talk over staff); per-customer rate limit; msgid
dedupe; bug / coverage-gap logging; **retrieval failure degrades to the full FAQ, never a
customer-visible outage**.

## Session log
- **2026-07-23** — Planned the framework restructure (plan file above). **Phase 1 (TS):**
  big-bang JS→TS of the whole Node codebase (tsconfig, tsx, `dist/` build); `http.ts`
  (dedup retry client); `prompt.ts` (tenant-templated system prompt behind a golden
  fixture). Types surfaced a real bug (`addUnanswered` callers omit `reason` → made
  optional). Verified: typecheck clean, 38 tests, live end-to-end Qwen call grounded
  correctly. Review fix: `tsconfig.build.json` (prod build = only `src/`).
- **2026-07-23** — **Phase 2 (Python):** `packages/knowledge/` — MCP server + CLI that
  chunks/embeds/hybrid-searches project corpora by `namespace`, against a dedicated
  `knowledge_dev` DB. Verified: chunk unit tests, MCP lists 4 tools, real 19-chunk ingest +
  semantic search correct. Install quirk: `editable_mode=compat`.
- **2026-07-23** — **Monorepo reorg + bug fix:** moved the bot into `packages/bot/`
  (history preserved), added the npm-workspace root. Fixed the Phase-1 compiled-FAQ-
  fallback path (`build` now copies `knowledge/` → `dist/`; verified it resolves to a 19 KB
  `dist/knowledge/faq.md`). Cleaned build artifacts; no dead source existed to delete.
