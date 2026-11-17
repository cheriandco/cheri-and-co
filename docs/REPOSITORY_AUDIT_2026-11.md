# Cheri & Co.: repository audit and completion roadmap (2026-11-18)

Status: **audit only.** No application code, schema, migration, configuration, Supabase, Vercel or n8n change was made for this audit. This file is the only file
added by it. Nothing was committed, pushed or deployed, no SQL was run, no OpenAI or other paid API was called, and no account or project was created.
Evidence comes from reading the source in `D:\cheri-and-co`, plus the safe local checks listed in section 9. **The hosted Supabase project was not queried**; anything that depends on its
live state is marked UNVERIFIED. This document supersedes the effort estimates and "pre-build" classifications in `docs/FINAL_DELIVERY_ROADMAP.md` where they differ (M2 to M5 were built locally after that was written).

## 0. Working tree recorded before the audit (preserved)

| Item | Value |
|---|---|
| Branch | `feature/client-delivery` |
| HEAD | `7bfa4ff` "feat: add Amazon Intelligence M5" (previous: `ce1ed98` M4, `6c95212` M3, `873e446` M2, `f9652af`) |
| Other branches | `main`, `demo/safe-demo` (public demo), `feature/supabase-foundation`, `parked/supabase-auth` |
| Uncommitted | 57 entries (24 modified, 33 untracked) before this report: the OpenAI pilot, Next.js 16.4.6 update, product edit/delete, Google-Maps prospecting module (isolated), docs, two unapplied migrations, tests |
| Remote | `origin` on GitHub (the roadmap records the repository as public) |

Discrepancies between the brief and the repository (confirmed): **Tailwind CSS and Framer Motion are not used** (not in `package.json`; styling is one plain stylesheet, `src/app/globals.css`, 341 lines).
**n8n does not exist in the repository**: no workflow, config or code; the only mention is a planned row in `docs/BUSINESS_CONTEXT.md:80`. Content drafting was originally Claude; the owner switched it to OpenAI, so the older "Claude + Canva" wording in some docs is stale.

---

## 1. Executive summary

Cheri & Co. is a **well-built, well-tested, secure-by-design CRM and approvals application with a demo layer of five agents on top**. It is not yet an operational platform with five working agents.

- **Really working against Supabase (by code and local tests; hosted behaviour UNVERIFIED except the foundation):** sign-in and roles, organisation scoping, customers, retailers, B2B pipeline, tasks, products (create, edit, delete), orders (create, status), CSV import, social-post planning, the Approval Centre, audit and activity log, one Sales report.
- **The five "agents" are mostly deterministic rules, not AI.** Only Content & Marketing has an OpenAI path, and it has never been called (off by default, key never used, live call not approved).
- **No agent executes an external action.** There is no sending, posting, publishing or marketplace write anywhere. Approving records a decision only. This is by design and is the main safety property.
- **The orchestrator is a read-only dashboard summariser.** It does not route requests, run workflows, track execution or recover from failure.
- **B2C Sales (live) is a rule-based "customer follow-up opportunities" list**, not an enquiry-handling agent. There is no conversation storage and no Instagram intake. **Amazon Intelligence has a substantial local SP-API implementation that has never run against Amazon and whose migration has not been applied.** **B2B has no lead sourcing** for live organisations.
- **Client inputs are the real critical path:** real catalogue data, approved claims, brand rules, policies, Amazon access, named approvers. Without them most agents cannot say anything verified.

Honest readiness: **suitable today as a private internal CRM/catalogue/approvals tool for the owner; not yet suitable to present as five working AI agents.** Quality gates are green: typecheck, lint, 808 passing tests (2 skipped by design), production build.

---

## 2. Overall completion matrix

Live Data = reads/writes the real Supabase database for a signed-in live organisation. Tested = automated tests exist (fake client or in-process Postgres); none of it has been exercised against hosted Supabase except the foundation SQL check recorded in the older docs (UNVERIFIED now).

| Module | Status | Live Data | AI Connected | Tested | Remaining Work |
|---|---|---|---|---|---|
| Authentication, roles, route protection | COMPLETE (local) | Yes | n/a | Yes (`auth.test.ts` 23, `rls.test.ts` 36) | Hosted sign-in test; disable public sign-ups (user action) |
| Organisation scoping and RLS | COMPLETE in SQL | Yes | n/a | Yes, real SQL in PGlite | Re-run `docs/rls_live_check.sql` on hosted |
| Customers (CRUD) | PARTIAL | Yes | No | Yes | No delete; edit and create only |
| Retailers and leads / B2B pipeline | PARTIAL | Yes | No | Yes | No delete; no lead sourcing |
| Products | PARTIAL | Yes | Feeds Content | Yes | No description/image columns; edit/delete newly added, uncommitted, unverified live |
| Orders | PARTIAL | Yes (screen on customers page, API + form) | No | Yes | No delete; no line-item UI |
| Tasks and follow-ups | COMPLETE for basics | Yes | No | Yes | Assignee not stored for live (ignored) |
| CSV import | PARTIAL | Yes | No | Yes | Customers, retailers, tasks, orders only; not products |
| Reports | PARTIAL | Sales only | No | Partial | 6 of 7 sections sample only; live shows Sales only |
| Dashboard | PARTIAL | Counts only | No | Partial | KPI cards, trends, agent tiles hidden/demo for live |
| Approval Centre | COMPLETE (decision only) | Yes | No | Yes (`m5-approval-guard` 31) | No execution step by design; named approvers |
| Agent activity / audit log | COMPLETE | Yes | n/a | Yes | None |
| B2C Sales agent | PARTIAL | Yes (opportunities from customers/orders) | No | Yes (35 + 27) | No enquiries, conversations, intake or channel; rule-based |
| B2B Lead agent | PARTIAL | Pipeline yes; discovery MOCK | No | Yes | No lead source; live follow-up drafts via record page only |
| Amazon Intelligence | PARTIAL, UNVERIFIED | Local SP-API code; tables not applied | No (rules only) | Yes with fakes (about 110) | Apply migration, connect, real sync, verify vs Amazon |
| Content & Marketing | PARTIAL | Posts and calendar yes | Yes (OpenAI, off) | Yes (72 + 40 + 32) | Live call test; claims/brand data; pack generator and assets unavailable live |
| CRM & Sales Ops | PARTIAL | Yes | No | Yes | Conversations tab empty; no deletes |
| AI Business Orchestrator | MOCK ONLY (summary view) | Counts only | No | Light | No routing or workflow engine |
| OpenAI foundation | PARTIAL | n/a | Content only | Yes (fake transport) | Never called live |
| n8n / automation | NOT IMPLEMENTED | n/a | n/a | n/a | Nothing exists |
| Google Maps prospecting (isolated) | PARTIAL, not wired | No | No | Yes (160) | Deliberately unused; no schema; scope decision |
| Public demo (Vercel `main`) | COMPLETE, separate | No (sample) | Never | Yes (`demo-isolation`) | Keep untouched |
| Production deployment | NOT VERIFIED | n/a | n/a | n/a | Env, domain, hosted checks |

---

## 3. Five-agent audit

### 3.1 B2C Sales
- **Works now (live):** `getB2cOpportunities` (`src/services/index.ts`, `src/lib/b2c-opportunities.ts`) derives follow-up opportunities from the organisation's customers and orders using provisional thresholds shown on the page; `liveQueueB2cFollowUp` (`src/services/live.ts`) turns one into a pending approval, rebuilt server-side; page `src/app/(app)/b2c/page.tsx` (`LiveB2C`).
- **Mocked:** the enquiry-reply engine (`src/lib/b2c-agent/{intent,preferences,search,respond}.ts`, `runB2CAgent`) works only on the SAMPLE catalogue (`src/mocks/catalogue.ts`). `POST /api/agents/b2c/run` returns **501 for live organisations**. Conversation list is sample.
- **Missing:** conversation/message storage, Instagram or any enquiry intake, live catalogue adapter (the live `products` table has no style, occasion or material), policies, escalation owner, send step.
- **AI:** none; deterministic rules.
- **Activity logging:** queue and decision are logged. **Tests:** `b2c-agent.test.ts` (35), `b2c-opportunities.test.ts` (27), `m4-api.test.ts` (21). **Missing tests:** live enquiry flow (does not exist).

### 3.2 B2B Lead
- **Works now (live):** retailer and lead create/edit, stage moves (`liveMoveDeal`), retailers list, CSV import, follow-up draft per retailer queued to approval (`liveQueueB2bFollowUp`, button on `retailers/[id]/page.tsx`, rules `followUpFor`/`followUpEmail` in `src/lib/agent-logic.ts`).
- **Mocked:** discovery (`getDiscovery`, `mocks/agent-samples.ts`, 6 invented candidates) and "Follow-up recommendations" are shown to the demo only (`!live` in `b2b/page.tsx`).
- **Isolated, unused:** `src/lib/prospecting/**` (Google Places client, scoring rubric, duplicate detection). Guard tests prove nothing imports it, no fetch, no key, no schema. It is a design asset, not a feature.
- **Missing:** any real lead source, scoring on live leads, WhatsApp wording (drafts are email-style), delete.
- **AI:** none. **Tests:** `agents-demo`, `m3-api` (15), prospecting (160, isolated).

### 3.3 Amazon Intelligence
- **Implemented locally, unverified:** SP-API client with LWA tokens, throttling, host allow-list, redaction (`src/lib/amazon/**`); bounded resumable sync (`src/lib/amazon/sync/*`); six pure insight rules (`insights/rules.ts`); Supabase repo running as the user under RLS (`supabase-repo.ts`); routes `src/app/api/amazon/*`; service `src/services/amazon-live.ts`; UI `amazon-live-view.tsx`.
- **Blocking facts:** migration `supabase/migrations/20261111000000_amazon_intelligence.sql` (8 tables) is **not applied anywhere** (per `docs/M5_AMAZON_INTELLIGENCE.md`); no seller credentials; `amazon-sandbox.live.test.ts` is gated (2 of its 3 tests are skipped). Never verified against Amazon.
- **Mocked:** the demo's 8 tabs (competitors, reviews, pricing) stay sample; they are intentionally absent for live organisations. No competitor, price-comparison or review data source exists live.
- **AI:** none ("rules first, AI narration later (not built)"). **Tests:** about 110 with fakes (`amazon-*.test.ts`, `m5-*`).
- **Missing:** applied schema, Amazon India access, Flipkart, click/purchase tracking.

### 3.4 Content & Marketing
- **Works now (live):** social post create/edit/calendar/submit (`createSocialPost`, `updateSocialPost`, `submitSocialPost`, `src/lib/social/posts.ts`); claim guard (`src/lib/content-agent/claims.ts`) at submit and approve; approved status mirrors the approval (`liveSocialPosts`).
- **OpenAI path (built, off, never called):** `src/lib/ai/{config,client,transport,redact,limits}.ts`, `src/lib/content-agent/{ai-prompt,ai,live-source}.ts`, `src/services/{content-ai,ai-ledger}.ts`, route `src/app/api/agents/content/run/route.ts`. Redaction, strict JSON schema, `store:false`, output validation, claim guard, spend and daily limits recorded in `agent_activity`, template fallback. Only signed-in live organisations can reach it. Doc: `docs/AI_PROVIDER_OPENAI.md`.
- **Unavailable live:** pack generator, brand rules, assets, performance tab (each shows "not available yet"). Live catalogue rows carry no style tags, approved claims or links, so live drafts make no such claims.
- **Missing:** a verified live OpenAI call; Brand Brain data (brand rules table); Canva beyond a text brief; publishing (by design); image/description fields on products.
- **Tests:** `content-agent` (72), `ai-content` (40), `ai-core` (32), `social-agent` (18), `live-data`.

### 3.5 CRM & Sales Ops
- **Works now:** customers, retailers, leads, tasks, orders, approvals, activity, audit (`src/services/live.ts`); suggestions from real tasks and deals (`buildSuggestions`); Sales report (`liveSalesReport`) from delivered orders.
- **Partial/missing:** conversations tab empty; reports other than Sales are sample (demo only); no delete for customers/retailers/orders/tasks; live tasks ignore assignee; no import for products; no merge/duplicate handling for customers.
- **Tests:** `live-data` (110), `m2-api`, `csv-import`, `rls`.

---

## 4. Orchestrator audit

**Genuine multi-agent orchestration does not exist.**
- `getOrchestratorBrief` (`src/services/index.ts`) and `GET /api/orchestrator/brief` build a per-agent headline, up to five rule-based recommendations (`buildSuggestions`), the latest activity feed and three totals. For live organisations B2C/B2B/Content/CRM headlines are real counts; Amazon says "Not connected to the database yet".
- It does **not**: receive requests or events; select an agent; pass data to an agent; chain agents; track execution status; handle failures or retries; or return a consolidated result of work done. Agents are not invocable by it, and there is no queue, scheduler or event bus. Cross-agent coordination today happens only through the shared database and the human Approval Centre.
- Verdict: **a read-only coordination dashboard.** Calling it an orchestrator is accurate only in the UI sense. A real one is a defined milestone (section 7, Milestone 6).

---

## 5. Database and integration audit

**Hosted state UNVERIFIED.** Per owner-reported SQL results: organisation "Cheri & Co." (`is_demo=false`), one auth user, one owner membership, `agent_activity` has two policies with insert/select privilege only.

**Migrations in the repo:** `20261101000000_foundation.sql` (applied per docs), `20261111000000_amazon_intelligence.sql` (**not applied**), `20261112000000_revoke_rls_auto_enable_execute.sql` (reviewed, **not applied**).

**Foundation tables (13):** `organizations`, `profiles`, `memberships`, `customers`, `products`, `retailers`, `leads`, `orders`, `tasks`, `approvals`, `content_items`, `agent_activity`, `audit_log`. RLS on all; read = member, write = owner/admin/approver/staff, delete = owner/admin; `approvals` and `agent_activity` insert-only for writers; `audit_log` and `agent_activity` append-only by trigger; `decide_approval()` is a SECURITY DEFINER function that sets the actor from `auth.uid()`. Composite `(org_id, id)` keys block cross-tenant links. No API can create organisations or memberships.

**Amazon tables (proposed, 8):** `amazon_connections`, `amazon_sync_runs`, `amazon_orders`, `amazon_order_items`, `amazon_products`, `amazon_inventory`, `amazon_reports`, `amazon_insights`.

**Missing tables/capabilities:** conversations/messages, brand rules, assets/media, product description and image columns, content packs, notification/outbox, workflow/run tracking for an orchestrator, per-org AI usage table (deliberately avoided; `agent_activity` is used instead), unsubscribe/consent for outreach, any delivery-status storage.

**Integrations:** Supabase (yes); OpenAI (built, off); Amazon SP-API (built, unapplied, unverified); Google Places (isolated, off); **n8n none; Instagram/Meta none; WhatsApp none; email provider none; Canva none; Flipkart none.** The only outbound `fetch` in `src` outside same-origin API calls lives in the OpenAI, Amazon and (unwired) prospecting transports.

---

## 6. Security and production readiness

**Confirmed (from code, `src/proxy.ts`, `src/lib/auth/*`, tests):**
- `AUTH_MODE` defaults to demo; `required` forces a verified Supabase session on every page and API; `getAuthUser` re-verifies with the Auth server and reads the role from `memberships`, never from the browser.
- Every API handler starts with `deny(permission, req)`; unauthenticated delete returned 401 locally. Same-site and JSON checks on writes. Org id always comes from the session; the service-role admin client is imported by nothing.
- Security headers set in `next.config.ts`. No real key or token found in source, tests, docs or `.env.example`; `.env.local` is git-ignored; only `.env.example` is tracked.
- AI off by default (`AI_ENABLED` must equal `true`); public demo and demo orgs never reach OpenAI.
- Login errors are generic; there is no sign-up action in the app.

**Confirmed issues / pending items:**
1. **Public sign-ups last seen ON** (`disable_signup:false`), not changed. A stranger gets no membership and can do nothing, but this is unwanted and a no-go for launch per `docs/APP_DEPLOYMENT_PREPARATION.md`.
2. Two migrations (Amazon, revoke of `rls_auto_enable()` EXECUTE) not applied; the revoke is a pending security hardening.
3. Dashboard text says "DEMO ENVIRONMENT … NOT CONNECTED TO LIVE BUSINESS SYSTEMS" on every page including live ones (hard-coded in `src/app/layout.tsx`); the Orchestrator card also says "SAMPLE data" and "in this demo" for live organisations (`agent-views.tsx`). Misleading labels, not a data leak.
4. Hard delete only; no soft delete or undo. Product delete is audited only through the activity log text.
5. Large uncommitted working tree on a feature branch; nothing of the pilot, Next 16.4.6 update, or product edit/delete is committed.

**Unverified risks:** hosted RLS for later slices; PostgREST paging and row limits; rate limiting is in-memory per instance (AI) and absent elsewhere; no login throttling beyond Supabase's own; free-tier pause/backup limits; the repository's public visibility and git history not scanned for secrets in this audit; `eslint-config-next` is 16.4.0 while Next is 16.4.6; Vercel production variables, domain and cookie settings; whether the second draft product has a duplicate SKU (the schema's `unique(org_id, sku)` makes a literal duplicate impossible, so the screenshot reading was not verified; left untouched as instructed).

---

## 7. Remaining development roadmap

Priorities: P0 blocks operational launch, P1 needed for the agreed deliverables, P2 improves. "Tests" means new or extended automated tests; all tasks end with typecheck, lint, tests, build. Schema tasks need the owner's explicit approval first. The order below follows the repository's dependency graph, which matches the requested milestone sequence, with one change: **client inputs and hosted verification (Milestone 0) come first** because every later milestone depends on real data and on proving hosted behaviour.

### Milestone 0 (added): decisions, hosted verification, hygiene
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 0.1 Scope sign-off | Owner confirms five agents, channels and what "live at launch" means | `docs/FINAL_DELIVERY_ROADMAP.md` section A | none | Written confirmation | n/a | P0 |
| 0.2 Hosted verification | Owner signs in locally; add, edit, delete a test product; run `docs/rls_live_check.sql` read-only | `docs/LIVE_READINESS_RUNBOOK.md` | owner | All PASS | existing | P0 |
| 0.3 Commit hygiene | Review and commit the pilot, Next update, product delete on a branch | git | approval | Clean tree, branch pushed on approval | existing | P1 |
| 0.4 Labels | Show the demo banner and "SAMPLE/in this demo" wording only in demo mode | `src/app/layout.tsx`, `src/components/agent-views.tsx` | approval | No demo wording for live org | extend `demo-isolation` | P1 |
| 0.5 Close sign-ups | Turn off "Allow new users to sign up" (user action) | Supabase dashboard | owner | `disable_signup:true` seen | n/a | P0 |

### Milestone 1: core CRM and data foundation
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 1.1 Product fields | Add `description`, `image_url` (and optionally storage) to products, form and validation | new migration, `src/lib/validate.ts`, `src/components/product-form.tsx`, `src/services/live*.ts`, `src/types` | schema approval | Edit and save both; RLS unchanged | rls, live-data | P1 |
| 1.2 Deletes for other records | Delete for customers, retailers, tasks (orders: cancel instead) with confirm | `[resource]/[id]/route.ts`, `live.ts`, `product-row-actions` pattern | roles | Owner/admin only; 404 cross-org | live-data, rls | P2 |
| 1.3 Product import | CSV import for products | `src/services/import.ts`, `src/lib/import.ts` | none | Bad row imports nothing | csv-import | P1 |
| 1.4 Duplicate/consistency guard | Duplicate customer detection on create/import | `src/lib/validate.ts`, services | none | Warns on same phone/email | m2-api | P2 |
| 1.5 Live reports | Live sections for CRM/B2B/Content from real tables | `getReports`, `live.ts` | data | No sample numbers for live | live-data | P1 |

### Milestone 2: complete Content & Marketing
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 2.1 Brand Brain data | Store brand rules and approved claims per org (schema approval) | new migration, `getBrandRules`, `live-source.ts` | 0.1, client input | Drafts use stored rules; no unapproved claim | content-agent, ai-content | P1 |
| 2.2 First live OpenAI test | One approved call, price vars, hard OpenAI limit, `AI_ENABLED=true` only in the authenticated app | `docs/AI_PROVIDER_OPENAI.md` checklist | owner approval, 0.2 | Ledger row written; draft needs approval | extend ai-content with recorded real response shape | P1 |
| 2.3 Live pack/asset support | Packs and assets or remove tabs for live | `content/page.tsx`, services | 1.1 | No "not available" tabs | m2-components | P2 |
| 2.4 Distributed rate limit | Replace per-instance limiter if more than one instance | `src/lib/ai/limits.ts` | deploy | Limit holds across instances | ai-core | P2 |

### Milestone 3: complete B2C Sales
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 3.1 Conversation storage | Tables for conversations/messages (schema approval) | migration, `src/types`, services | scope, policies | RLS-isolated; persists | rls, new | P1 |
| 3.2 Manual enquiry entry and draft | Staff pastes an enquiry; engine drafts from live products | `src/lib/b2c-agent/*`, `api/agents/b2c/run/route.ts` (remove 501 for live) | 3.1, 1.1 | Draft never states unverified price/stock/claim; escalation flags | b2c-agent | P1 |
| 3.3 Catalogue adapter | Map live `products` plus client attributes to `CatalogueProduct` | `src/lib/b2c-agent/search.ts` | client data | Recommends only verified facts | b2c-agent | P1 |
| 3.4 Optional AI drafting | Reuse the OpenAI wrapper with redaction (customer identifiers must stay out) | `src/lib/ai/*` | 2.2 | PII never sent | ai-core | P2 |

### Milestone 4: complete B2B Lead
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 4.1 Lead source decision | Manual/CSV or Google Places (`src/lib/prospecting`) | scope doc | 0.1, Places billing | Decision recorded | n/a | P0 |
| 4.2 Live qualification/scoring | Score real leads with the rubric | `src/lib/prospecting/scoring`, `liveRetailers*` | 4.1 | Score and reason shown | prospecting-scoring | P1 |
| 4.3 Live recommendations | Un-hide follow-up recommendations for live | `b2b/page.tsx` | none | Real retailers only | live-data | P1 |
| 4.4 WhatsApp wording | Add WhatsApp-style prepared message (human sends) | `src/lib/agent-logic.ts` | client tone | Draft only | agents-demo | P2 |

### Milestone 5: complete Amazon Intelligence
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 5.1 Apply migration | Owner applies the Amazon migration after review | `supabase/migrations/20261111…` | approval | Tables exist, RLS verified | m5-schema-draft, rls | P1 |
| 5.2 Seller connection | Private SP-API app and env vars | `docs/M5_SANDBOX_CONTRACT.md` | Amazon access | `amazonVerify` passes | amazon-client | P1 |
| 5.3 First real sync | Orders, listings, inventory | `src/lib/amazon/sync/*` | 5.1, 5.2 | Data on `/amazon` with source and date | amazon-sync | P1 |
| 5.4 Competitor/price data | Decide a source (CSV or API); none exists | new module | client | Evidence-cited insights | amazon-insights | P2 |

### Milestone 6: AI Orchestrator
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 6.1 Define scope | Decide the minimum: event intake, routing table, run tracking | docs | 0.1 | Approved design | n/a | P1 |
| 6.2 Run tracking | Persist a run, status and result per request (schema approval) | migration, `src/services` | 6.1 | Status visible; failure recorded | rls, new | P1 |
| 6.3 Routing and consolidation | Route an event to one agent, call its service, return one result and activity | `getOrchestratorBrief`, new `src/lib/orchestrator` | 6.2, milestones 2-5 | Multi-agent flow end to end | new | P1 |
| 6.4 Live B2C/Amazon tiles | Real counts for all five agents | `liveBrief` | 3, 5 | No "not connected" tile | live-data | P1 |

### Milestone 7: Approval Centre and end-to-end integration
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 7.1 Define execution | Decide what happens after approval (manual send, n8n webhook, email provider) | docs, `decide_approval` | 0.1 | Written decision | n/a | P0 |
| 7.2 Execution tracking | Add executed/failed state only if an automated action is chosen | migration, approvals UI | 7.1 | Status shown; no double send | m5-approval-guard | P1 |
| 7.3 n8n (only if chosen) | Signed webhook from approved items; secrets in env | new route | 7.1 | Replay-safe, org-scoped | new | P2 |
| 7.4 End-to-end tests | Each agent: draft, approve, record | tests | milestones 2-5 | All green | e2e | P1 |

### Milestone 8: production readiness and handover
| Task | Requirement | Files | Depends | Acceptance | Tests | Pri |
|---|---|---|---|---|---|---|
| 8.1 Hosted verification pass | Staged checks in `docs/APP_DEPLOYMENT_PREPARATION.md` | n/a | all | Go/no-go list ticked | existing | P0 |
| 8.2 Environment and domain | Production env, Site URL, domain, separate project from demo | Vercel/Supabase (owner) | approvals | App on its own URL | smoke | P0 |
| 8.3 Backups and runbook | Backup plan, user/membership runbook, rollback | docs | 8.2 | Rehearsed | n/a | P1 |
| 8.4 UAT and handover | Client acceptance sheet naming live vs not | docs | all | Signed | n/a | P0 |

---

## 8. Final delivery assessment

1. **What can the client use today?** A signed-in, role-protected workspace to manage customers, retailers, a B2B pipeline, tasks, products (add, edit, delete), orders, CSV imports, social-post planning and the Approval Centre, with an activity log. Hosted behaviour beyond the foundation is unverified.
2. **Only a visual demonstration:** the demo dashboard KPIs and trends, six of seven reports, B2C enquiries, B2B discovery and follow-up recommendations, Amazon competitor/review/pricing tabs, the pack generator, the Orchestrator as a coordinator.
3. **Actually connected to Supabase:** all CRM, products, orders, tasks, approvals, audit, activity, content posts, auth and memberships. Amazon tables are not yet applied.
4. **Connected to OpenAI:** only Content & Marketing drafting, code present, disabled, never called. B2C, B2B, Amazon, CRM and the Orchestrator are not.
5. **Connected to n8n:** nothing. No n8n artefact exists.
6. **Agents that can execute real work today:** none execute external work. B2C (follow-up opportunity list), B2B (draft follow-ups) and Content (planning and drafts) produce reviewable drafts into the Approval Centre; CRM manages records; Amazon cannot run until its migration and credentials exist.
7. **Blocking operational launch:** client inputs (catalogue, claims, brand rules, policies, named approvers, Amazon access); hosted verification; sign-ups still on; unapplied migrations; no conversation storage or lead source; decision on what approval triggers; uncommitted work; misleading demo labels.
8. **Shortest realistic path:** (a) owner closes sign-ups and does the hosted verification (0.2, 0.5); (b) commit and review the current tree (0.3); (c) collect real catalogue, claims and brand rules and add description/image fields (1.1, 2.1); (d) one approved live OpenAI test (2.2); (e) launch as a **CRM + catalogue + content-draft + approvals** workspace with B2C opportunities and B2B pipeline, labelling Amazon, B2C chat and lead discovery as "coming next"; (f) then Milestones 3 to 6 as data and decisions arrive.

---

## 9. Commands and tests executed for this audit

| Command | Result |
|---|---|
| `git status`, `git log`, `git branch -a`, `git remote -v` | recorded in section 0 |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `npx vitest run` (JSON reporter, scratchpad) | 27 files, 810 tests: **808 passed, 0 failed, 2 skipped** (live Amazon sandbox tests, gated) |
| `npm run build` | passed earlier in this session after the product delete change; not re-run for this report |
| Reads and searches (`grep`, `find`, `sed`) over `src`, `tests`, `docs`, `supabase/migrations`, `next.config.ts`, `package.json`, `.gitignore`; environment variable **names only** from `.env.local` (no values) | no secrets exposed |
| `curl` to the local dev server (`/products`, unauthenticated `DELETE /api/products/{id}`) | 307 to login; 401 |
| Not done by design: SQL, Supabase, Vercel, n8n, OpenAI, Amazon, Google calls; account creation; commits, pushes, deploys; modification of any existing file or product | |

**Failures:** none in the checks above. One earlier command in this session hung (a stray `python3` heredoc) and was stopped; it touched no files.

No implementation follows from this audit. Awaiting explicit approval for the next milestone.
