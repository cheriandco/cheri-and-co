# Cheri & Co.: final delivery roadmap

Status: **audit and planning only.** Prepared from the repository at `feature/supabase-foundation` (HEAD `ac29323`). No code, schema,
Supabase, Vercel, DNS or GitHub change was made, nothing was committed, and the hosted services were **not** queried. Effort figures are
engineering **estimates** (one engineer, working days, excluding client wait time and review turnaround), not measured. Anything that cannot be
answered from the repository is marked **UNVERIFIED**.

Companion document: `docs/APP_DEPLOYMENT_PREPARATION.md` (hosting, domain, environment, Supabase, staged checks, final decisions).

Classification labels used below:
**DEMO** implemented and working in demo (sample data) · **LIVE** connected to the live database · **NOT-INTEGRATED** implemented but not wired to live data ·
**MISSING** not implemented · **ACCESS** needs a client account or API access · **DECISION** needs a client decision.

---

## A. Original agreed deliverables

**Provenance.** No signed proposal or scope document exists in the repository or in the project memory. The list below is reconstructed from
`docs/UX_FLOWS.md` §3, `docs/BUSINESS_CONTEXT.md`, `docs/DATABASE.md` §2, `docs/API.md`, `README.md`, `docs/PHASE1_UI_FREEZE.md` and the project
memory ("agents per agreed proposal"). Client confirmation of the agent scope is **not recorded**. This list must be confirmed with the owner
before it is treated as the contract.

1. **Five agents:** B2C Sales, B2B Lead, Amazon Intelligence, Content & Marketing, CRM & Sales Ops.
2. **AI Business Orchestrator** as a coordination layer (not a sixth agent): per-agent summary, recommendations, cross-agent activity.
3. **Central CRM/database** (Supabase) that all agents write to.
4. **Dashboard** as the human-approval interface.
5. **Human approval workflow:** nothing reaches a customer, marketplace or platform without a person approving it.
6. **Roles and sign-in** (owner, admin, approver, staff, viewer).
7. **Channel promises, as worded in the brief:** Instagram as the B2C enquiry channel; Amazon/Flipkart click and purchase tracking and an Amazon
   intelligence workflow; B2B retailer discovery and a pipeline New to Won/Lost; a content workflow using Claude and Canva with manual publishing;
   B2B WhatsApp messages prepared for a human to send.
8. **Hosting on the client's own authenticated application** at `app.cheri.co.in`, with the demo preserved.

---

## B. Completed deliverables (verified in the repository; hosted behaviour UNVERIFIED)

| Commit | Delivered |
|---|---|
| `84795ec` (`main`, production demo) | Five-agent demo with Orchestrator, dashboard, approvals, social workflow, demo-safety labelling. |
| `a28d07f` | Supabase foundation: 13 tables with RLS, memberships-based tenancy, `decide_approval()`, append-only audit, email+password sign-in, `AUTH_MODE`, route guards, `deny()` on every API handler. |
| `28a4708` | Live tasks, approvals (through `decide_approval()`), audit log, agent activity, dashboard/orchestrator counts. |
| `386707d` | Live customers, retailers, leads (B2B pipeline): read, create (API), stage moves. |
| `3a7706a` | Live products (list, detail, create/edit form) and content: social posts create/edit/submit to approval; claim guard; orphan-approval undo. |
| `ac29323` | Live orders (**API only, by decision**) and a Sales report from delivered orders; purchase counts exclude cancelled and returned. |

Local checks recorded earlier in this engagement for the final tree: 286 tests pass, typecheck, lint and production build clean. **These were not
re-run for this audit.** The hosted-Supabase result on record is the 95/95 `docs/rls_live_check.sql` run, which covered the foundation tables
before Slices 2 to 4 (the schema has not changed since).

### B.1 Five-agent and platform status (classification)

| Component | DEMO | LIVE (database) | NOT-INTEGRATED / MISSING | ACCESS / DECISION |
|---|---|---|---|---|
| **1. B2C Sales** | Rule-based intent, preferences, sample-catalogue search, draft reply, escalation reasons (35 tests); sample conversation list; "send reply to approval (demo)". | **None.** Page says "Not connected yet"; `POST /api/agents/b2c/run` returns 501; `getConversations()` is empty. | **MISSING:** conversation/message storage, enquiry intake of any kind, Instagram connection. **NOT-INTEGRATED:** engine searches a `CatalogueProduct` (style, occasions, material) that the live `products` table does not hold. | **ACCESS:** Meta/Instagram business account (only for automated intake). **DECISION:** channel, policies (returns, shipping, discounts), escalation owner and hours, languages, approvers. |
| **2. B2B Lead** | Discovery over 6 SAMPLE candidates with "why this score", add to leads, follow-up recommendations and email drafts. | Retailers, leads and pipeline: read, create (API only), stage move persists. | **NOT-INTEGRATED:** discovery and follow-up drafting are hidden or refused for live organisations (sample only). **MISSING:** any real discovery source; a create-retailer form (API only); WhatsApp message preparation beyond the demo email-style draft (**UNVERIFIED** how it is worded). | **DECISION:** where leads come from (manual entry, Meta/Google Ads, field sales). **ACCESS:** none needed for manual entry. |
| **3. Amazon Intelligence** | 8 tabs over invented rows: opportunities, competitors, reviews, pricing, listings, recommendations; "send to approval (demo)". | **None.** Page says "Not connected yet"; `getAmazon()` empty. Only indirect: `orders.channel` accepts amazon/flipkart, and the Sales report counts delivered orders. | **MISSING:** all Amazon/Flipkart tables and data, import path, click/purchase tracking, live recommendations. | **ACCESS/DECISION:** Seller Central or Brand Analytics exports, or API access; Flipkart export; manual-versus-API choice. |
| **4. Content & Marketing** | Template drafts (caption, hashtags, reel/ASMR scripts, stories, Canva brief) for SAMPLE products and packs; social workflow with simulated publish; SAMPLE metrics. | Social posts: create, edit, submit to approval, calendar; claim guard at submit and approve; status mirrors the decision. | **NOT-INTEGRATED/unavailable live:** pack generator, brand rules, assets, performance, published tab (each says "not available yet"). **MISSING:** Claude drafting (reserved flag, off, no code reads a key), Canva beyond a text brief, any publishing (by design). | **ACCESS:** Anthropic Console API key plus usage billing; Canva plan check. **DECISION:** approved claims, brand voice, catalogue, marketplace links. |
| **5. CRM & Sales Ops** | Overview with suggested next actions, profiles, pipeline, tasks, activity, 7 report sections (sample). | Customers, retailers, leads/pipeline, tasks, products, orders (API), Sales report, activity and audit. | **MISSING (UI):** no create form for customers, retailers, tasks or orders (API only). No import path. Conversations tab empty. Six of seven reports are sample only. | **DECISION:** who enters data and how; role matrix; order entry method. |
| **AI Business Orchestrator** | Cross-agent summary, recommendations, feed. | Real counts for CRM, B2B and Content; recommendations from real tasks/deals; feed from `agent_activity`. B2C and Amazon tiles say "Not connected to the database yet". | Cannot summarise B2C or Amazon until they have data. Recommends only. | None. |
| **Central CRM/database** | Sample store in memory per visitor. | 13 tables, RLS, composite tenant keys, append-only audit. | **MISSING tables:** conversations/messages, Amazon data. Brand rules, assets and packs are not stored either. | Schema additions need owner approval. |
| **Dashboard** | KPI cards, trends, range selector, agent tiles (mock numbers). | Pending approvals, open tasks, pipeline funnel, top retailers. | KPI cards, trend, agent tiles, date range are empty or demo-only live. | **DECISION:** accept as is, or fund live KPIs (optional, item O3). |
| **Human approval workflow** | Queue, approve, reject, edit, audit list. | `decide_approval()` with real actor, decide-once, audit row, claim guard on content. | "Execute" and "Completed" steps are not implemented **by design**: approval records a decision and sends/publishes nothing. Live "agent action" queueing for B2C, B2B and Amazon returns "not connected" (only content submission queues for live). | **DECISION:** what happens after approval (send via which channel), named approvers. |

**Summary.** For a live organisation, two of the five agents (B2C Sales, Amazon Intelligence) have no live function at all; Content is partial;
B2B and CRM are live for stored records but depend on API-only data entry. None of the demo intelligence features (discovery, review themes, pricing
gaps, B2C recommendations from a verified catalogue) is production-ready. **Do not describe the product as five working live agents.**

---

## C. Remaining mandatory work

"Mandatory" means required to reach the agreed deliverables in A at a standard that can be presented to the client as real. Anything not needed for that is in
section J or listed as optional. Items marked **[needs approval]** change the schema and need the owner's explicit approval before any work.

| # | Item | Why mandatory | Reuses |
|---|---|---|---|
| M0 | **Scope confirmation in writing** (client confirms A, the B2C channel, the Amazon data route, and what "live at launch" means). | Provenance gap; also decision F. | n/a |
| M1 | **Hosted verification of Slices 1 to 4** on a staging Supabase project (real sign-in, real queries incl. the paged `range` reads, approval round trip). The small fixes originally listed here were made in the overnight stabilisation sprint (uncommitted, awaiting review; `docs/OVERNIGHT_STABILISATION_REPORT.md`), so M1 is now mainly verification. | Nothing has run against the real service except the foundation SQL check. | Existing tests, `rls_live_check.sql` |
| M2 | **Data entry for the central CRM.** Forms (or CSV import) for customers, retailers, tasks and orders. Today they exist only as API routes. **Smallest option:** forms reusing `product-form` patterns and existing validators; no new tables. | The CRM and Sales report are unusable by a non-developer without it. | `src/lib/validate.ts`, `[resource]` routes, `product-form.tsx` |
| M3 | **Live agent-action to approval path** for B2C, B2B and Amazon suggestions. **Built for B2B only (local, uncommitted; see `docs/M3_AGENT_ACTIONS_TO_APPROVALS.md`); B2C and Amazon stay refused until they have a real data source.** | "Nothing reaches a customer without approval" must hold for all agents. | `queueAgentAction`, `decide_approval()`, claim guard, `liveSubmitSocialPost` pattern |
| M4 | **B2C Sales live (minimum faithful version).** Stored conversations and messages; manual enquiry entry/paste; draft from the engine; escalation flags; draft submitted to approval; reply sent by a person outside the app. Product recommendations require an adapter from live `products` plus client-supplied style/occasion/material attributes (or the agent states verified information is unavailable). **[needs approval: new tables]** | Agent 1 has no live function. | `src/lib/b2c-agent`, `ConversationList`, `NotConnected` removal, approvals |
| M5 | **Amazon Intelligence live (minimum faithful version).** Tables for products, competitors, reviews, pricing, listings; CSV import of client-supplied exports; live read of the 8 tabs; rule-based recommendations (reuse `pricePosition`, `amazonActionFor`); send to approval. Channel sales from the existing `orders` table. **[needs approval: new tables]** | Agent 3 has no live function. | `amazon/page.tsx`, `agent-logic.ts`, `AmazonInsightTable`, orders/Sales report |
| M6 | **Live B2B follow-up drafts** (hidden for live today) using the same rules over real retailers, submitted through M3. Discovery stays out unless the client chooses a source (see O2). | Promised "WhatsApp prepared for a human to send". | `followUpFor`, `followUpEmail` |
| M7 | **Staging then production deployment** per `docs/APP_DEPLOYMENT_PREPARATION.md` (release branch, new Vercel project, staging and production Supabase, DNS CNAME when approved). | The delivery vehicle. | Existing checklist |
| M8 | **Client acceptance testing and handover** (sign-off sheet, admin runbook, how to create users and memberships, backup/rollback). | Closes the engagement. | Existing docs |

Content & Marketing and CRM & Sales Ops need **no new mandatory build** beyond M1 to M3, M2 and the client inputs below. Claude drafting is deliberately **not** mandatory (see O1).

---

## D. Client inputs required

| Input | Needed for | Status |
|---|---|---|
| Written confirmation of scope (section A, which agents/channels at launch) | M0 | Not recorded |
| Real **product catalogue**: SKUs, names, categories, prices/MRP, stock, pack definitions (2/3/6/10, mixed), materials, images | M4 recommendations, Products, Content, Orders | Not supplied; all current samples are invented |
| **Brand information**: voice/tone rules, languages (Hindi/Hinglish?), words/claims that must not be used | Claim guard, B2C replies, Content | Not supplied (tone is an assumption) |
| **Approved product claims** (for example anti-tarnish, waterproof, hypoallergenic) | Content, B2C | Not supplied; unapproved claims are blocked by design |
| **Policies and business rules**: returns/exchanges, shipping/delivery, discounts/offers, care instructions | B2C answers (otherwise the agent says it cannot verify and escalates) | Not supplied |
| **People**: named approvers, escalation owner, hours, expected response time, who enters data | Roles, M3, M4 | Not supplied |
| **Social media access**: Instagram business account and Facebook page for planning/manual publishing; Meta developer access **only if** automated intake is chosen (O2) | M4 option, Content | Not supplied |
| **Amazon / Flipkart**: Seller Central or Brand Analytics report exports (CSV), or API credentials, plus listing/ASIN list, affiliate links | M5 | Not supplied |
| **Anthropic Console API key with usage billing** (a Claude Team plan is not API access); Canva plan details | Only O1 | Not supplied; not needed for mandatory work |
| **Domain/DNS owner** for `cheri.co.in`; Vercel and Supabase billing owners | M7 | Unidentified |
| Existing client website/database/backups, if any (inspect before assuming a fresh schema) | M7, M2 | Unknown |
| A short list of real test scenarios and a UAT contact | M8 | Not supplied |

---

## E. Exact development sequence

Each step starts only after the previous gate passes. Schema steps stop for the owner's approval first.

1. **Gate 0: approvals.** Owner confirms M0 in writing and approves this roadmap. Owner creates the staging Supabase project and applies the existing migration (owner action; nothing is created by this document).
2. **M1** Hosted verification of Slices 1 to 4 on staging with the single Owner test account, plus the small fixes. *Gate: sections 6/7 of the preparation document pass.*
3. **M2** Data-entry forms/import for customers, retailers, tasks, orders.
4. **M3** Live agent-action to approval path.
5. **Gate: schema approval** for conversations/messages and Amazon tables (single migration file, RLS tests added to the in-process Postgres suite, run on staging).
6. **M4** B2C live (tables, intake, drafts, escalation, approvals).
7. **M5** Amazon live (tables, CSV import, tabs, recommendations, approvals).
8. **M6** B2B follow-up drafts live.
9. **Integration pass:** Orchestrator and dashboard show real B2C and Amazon counts; labels checked so nothing simulated reads as live; sample names absent for the live organisation.
10. **M7** Production deployment (section H). **M8** UAT and handover.

---

## F. Estimated engineering effort (days; estimates, not measurements)

| Item | Work breakdown | Days |
|---|---|---|
| M0 | Scope sheet and sign-off preparation | 0.5 |
| M1 | Run hosted checks 1.0 · fix findings (allow 1.0) · review and commit the sprint fixes 0.5 | 2.5 |
| M2 | Four create forms (customer, retailer, task, order) 2.0 · CSV import for customers and orders 2.0 · tests 1.0 | 5.0 |
| M3 | Live queue path for three agents 1.5 · tests 0.5 | 2.0 |
| M4 | Migration + RLS + tests 1.5 · conversation list/detail on live data 1.5 · manual enquiry entry and run route for live 1.0 · catalogue adapter and attribute handling 1.5 · escalation/handover status 1.0 · approval link and tests 1.5 | 8.0 |
| M5 | Migration + RLS + tests 1.5 · CSV import with validation 2.5 · live reads for 8 tabs 2.5 · recommendations from imported data 1.0 · approval wiring and tests 1.5 | 9.0 |
| M6 | Live follow-up drafts and tests | 1.5 |
| Integration pass | Orchestrator, dashboard, labels, sample-leak checks | 1.5 |
| M7 | Project setup assist, env, region, domain, staged checks, rollback rehearsal | 3.0 |
| M8 | UAT support, fixes (allow), handover runbook | 3.0 |
| **Mandatory total** | | **about 36 days (range 30 to 44)** |

Not included: client response time, Meta/Amazon approvals, DNS propagation, billing setup, and any defects found by the client beyond the allowances.

**Optional items (not in the total, not requirements):**
- **O1** Claude drafting behind the reserved flag, same claim guard and approval flow: 3.0 to 4.0. Needs the client's API key and billing.
- **O2** Automated Instagram intake through Meta (webhooks, token handling, app review): 8 to 12 plus external review time. Only if the client confirms manual intake is not acceptable.
- **O3** Live KPI cards from existing tables (customers, open tasks, pending approvals, delivered revenue): 2.0.
- **O4** An Orders screen (by decision orders are API-only today; M2 adds only a create form): 3.0.
- **O5** Amazon Selling Partner API connection instead of CSV: 8 to 10, needs client credentials.
- **O6** Password reset/invite pages, MFA: 2.0 to 3.0. Today an administrator sets passwords in the dashboard.

---

## G. Testing and acceptance criteria

General: every item ends with typecheck, lint, tests and production build green; new tests prove organisation isolation, role refusal (403), demo/live
separation, and that no sample record is visible to the live organisation. Hosted checks use the single staging Owner account; other roles and
cross-organisation isolation are proven by automated suites and SQL fixtures (decision B in the preparation document).

| Item | Acceptance criteria |
|---|---|
| M1 | Real sign-in succeeds and lands on the dashboard; wrong password gives the generic error; the PostgREST filters used by Slices 1 to 4 return correct rows on staging; duplicate SKU gives 409; cross-organisation link refused; content submit creates an approval, `decide_approval()` updates the post; `rls_live_check.sql` all PASS on staging; Security Advisor clean. |
| M2 | A non-technical user creates a customer, retailer, task and order from the screen; invalid input shows a message; viewer is refused; CSV with a bad row reports the row and imports nothing partially. |
| M3 | A B2C, B2B or Amazon suggestion appears in Approvals with the real submitter; duplicates are refused; a decision writes an audit row; nothing is sent or changed externally. |
| M4 | A staff member enters an enquiry; the draft, intent and escalation reason appear; order-status, refund and complaint enquiries escalate; the draft never states an unverified price, stock or claim; "Submit for approval" creates a pending approval; the conversation persists after refresh; another organisation cannot read it. |
| M5 | Importing a client export populates all 8 tabs with that data only; the page labels the source and date of the import; recommendations cite the rule used; "send to approval" works; with no import the page says so instead of showing samples. |
| M6 | A follow-up draft for a real retailer is generated, reviewed and approved; nothing is sent. |
| Integration | Orchestrator shows real counts for all five agents; no sample name (for example "Aurelia") appears anywhere for the live organisation. |
| M7/M8 | Section 9 go/no-go checklist of the preparation document fully ticked; the client signs the acceptance sheet naming what is live and what is not. |

---

## H. Deployment sequence

Full detail and checklists: `docs/APP_DEPLOYMENT_PREPARATION.md` sections 3, 7 and 9. In order:
1. Secret and customer-data scan of the release branch (the repository is public); create the release branch (owner approval to push).
2. Staging Supabase (owner-created) and staging Preview of the new Vercel project; one Owner test account.
3. Staged checks 0 to 7 on staging, then rollback rehearsal.
4. Production Supabase (paid, owner-created), apply the same migration, turn off sign-ups, set Site URL, create the real organisation and first owner membership.
5. New Vercel project (paid plan) production variables: `AUTH_MODE=required` plus the two production public Supabase values; no service-role or Anthropic key.
6. Domain `app.cheri.co.in`: add in Vercel, then the CNAME (separate approval), certificate, final checks. The demo project and `main` stay unchanged throughout.

---

## I. Risks and dependencies

| Risk | Effect | Mitigation |
|---|---|---|
| Scope was never signed or confirmed | Disagreement about "complete" | M0 before any build |
| Hosted behaviour of Slices 1 to 4 never verified | Defects found late | M1 first, on staging |
| Public repository | Secret or customer-data exposure | Scan before push; no secrets or data in git; only public Supabase values in the bundle |
| Client inputs not supplied (catalogue, policies, claims, exports) | B2C and Amazon cannot be accurate; agents would have nothing real to say | Collect early (section D); the agent states unavailable information and escalates rather than inventing |
| Schema changes needed for M4 and M5 | Needs approval; migrations are forward-only | Single reviewed migration; staging first |
| Amazon data access is the client's | M5 depends on exports or credentials | CSV route needs only exports |
| List sizes (after the sprint, uncommitted): lists are read page by page and a list above 10,000 rows is refused with an error; the activity feed shows the latest 50 only. Paging by `range` is UNVERIFIED on the hosted API | A very large list is slow or errors instead of being cut silently | Hosted check in M1; revisit only if volumes grow |
| Row-level security has run on the hosted service only for the foundation check | Slice 2 to 4 policies unverified live | M1 re-run |
| Free Supabase / Hobby Vercel | Pauses, non-commercial use | Paid plans are the owner's intended choice (not purchased) |
| Anthropic key or other secret pasted in chat in the past | Key exposure | Rotation was recorded as parked by the owner; use dashboards, never chat |
| Single engineer, context-heavy codebase | Schedule slip | Keep to reuse, small changes, separate commits per slice |

---

## J. Explicit out-of-scope items

Not to be built or proposed under this engagement without a new written approval: any sixth agent; new dashboard modules or screens beyond
data-entry forms in M2/M4/M5; automatic sending of customer replies; automatic posting or publishing to Instagram, Facebook, LinkedIn or any
marketplace; WhatsApp automation (messages are prepared for a human to send); ad management (Meta, Amazon, Flipkart ads); a B2B-only online
portal; billing/Stripe; dealer or customer self-serve onboarding; multi-tenant administration screens; reporting beyond what exists; image
generation or other additional AI products; Canva automation; web scraping of Amazon, Flipkart, Etsy or Myntra; Google Places discovery;
multi-currency, Amazon Global/UAE/UK/US expansion; mobile apps; MFA and password-reset flows (optional O6 only); changes to the demo or `main`.

---

## Appendix 1: B2C Sales, code against missing functionality

| Needed capability | Existing code | Gap |
|---|---|---|
| Understand the enquiry | `classifyIntent` (13 intents, rule-based confidence), `extractPreferences` | Works; English only; **UNVERIFIED** Hinglish quality |
| Product recommendation | `searchCatalogue` over `CatalogueProduct`; hard filters (category, budget) plus soft scoring | Reads `SAMPLE_CATALOGUE` only. Live `products` has sku, name, category, price, stock, status, channels: **no style, occasion or material**. Adapter plus client attributes needed, or recommendations are limited to category and budget |
| Draft reply with safeguards | `planResponse` (never invents price/stock/claims; `autoAnswerPermitted`; escalation) | Reusable as is |
| Human escalation | Escalation reasons in the result; `needs_human` status in the sample conversation type | Not persisted; no assignee/queue |
| Enquiry processing for live orgs | `POST /api/agents/b2c/run` | Returns 501 for live; needs the live branch after M4 |
| Conversation storage | Sample conversation type and `ConversationList` component | **No table**; page and API return empty for live |
| Approval | `queueAgentAction("b2c", ref)` builds the text from sample records; live returns "not connected" | Needs M3 and a live conversation to reference |
| Instagram | `customers.instagram` text field; `orders.channel = instagram` | No webhook, no API, no send; replies are sent by a person outside the app |

## Appendix 2: Amazon Intelligence, code against missing functionality

| Needed capability | Existing code | Gap |
|---|---|---|
| Dashboard | `/amazon` 8 tabs, `AmazonInsightTable`, price-position logic, rule-based recommendation text | Reads `m.amazon*` samples; live returns empty and the page is gated by `NotConnected` |
| Data sources | None | **No tables**, no import, no API. Needs client exports (CSV) or credentials |
| Sales and channel data | `orders` table (channel, status, total, ordered_at); Sales report (delivered only) | Orders are API-only; no import; no per-channel breakdown screen; Flipkart data only via manual orders |
| Click/purchase tracking | Customer fields `amazonClicks`, `flipkartClicks` exist on the sample `Customer` type | Not in the live schema; cannot be derived from available data. Needs affiliate/Brand Analytics export. Mark **MISSING** |
| Competitor, review, pricing, listing intelligence | Sample types and display; rules for opportunity score are sample numbers | Scores in sample rows are hard-coded; live version needs defined formulas (**DECISION**) or imported scores |
| Approval | `queueAgentAction("amazon", ref)` | Live path refused; needs M3 |
| Required API vs manual | n/a | Minimum: CSV import (M5). API (O5) optional |

## Appendix 3: Slices 1 to 4 review

**What the tests prove.** (Counts below are from before the sprint; the suite now has 312 tests.) `tests/live-data.test.ts` (about 79 test cases, recording fake Supabase client) proves application logic: every query is scoped to the
session's organisation, roles are enforced per route (viewer 403), validators reject bad input, mappers fall back safely, demo/live separation, and the
business rules for purchases and revenue. `tests/rls.test.ts` (about 36 cases) runs the real migration in an in-process Postgres and proves policy behaviour, composite keys,
append-only audit and `decide_approval()`. `tests/auth.test.ts` (about 23, fake client) proves guards and redirects. Agent tests (B2C, Content, Social, demo isolation) prove
the rule-based drafting and demo safety. The hosted check (95/95) proved the foundation policies on the real project.

**What they do not prove (UNVERIFIED):** real sign-in; PostgREST accepting the exact filter syntax in the live queries (`.not("status","in",…)`, `.in("platform",…)`,
`.gte(…)`, the embedded `organizations(is_demo)` join); the approval round trip on the hosted service; duplicate-SKU and foreign-key error codes as PostgREST returns them;
anything behind `app.cheri.co.in` (CSRF origin check via `x-forwarded-host`, cookies, HSTS); Slices 2 to 4 under the hosted policies.

**Unfinished or known defects.** Items 1, 2, 3 and 5 were fixed afterwards in the overnight stabilisation sprint (uncommitted; see `docs/OVERNIGHT_STABILISATION_REPORT.md`). Correction to this audit's first draft: item 2 was misdescribed. The live code never stored "Anika"; the real defect was that the Tasks screen showed the demo's hard-coded name picker (Anika, Dev, Meera) for real organisations and reported success for assignee changes that were not saved.
1. Older write routes (tasks, pipeline, approvals) did not map a database refusal to 403; an RLS refusal there would have surfaced as 500. **Fixed (uncommitted).**
2. The live Tasks screen offered a demo name picker whose changes were not saved. **Fixed (uncommitted):** plain text for real organisations, and the API refuses an assignee change with 409.
3. Stale text in Settings and `docs/SUPABASE_SETUP.md`. **Fixed (uncommitted).**
4. No create forms for customers, retailers, tasks or orders (API only); no import path. **Built for M2 on `feature/client-delivery` (uncommitted, local tests only; not verified against a hosted database or seen with live data):** forms, edit for customers and retailers, order status, CSV import with preview, duplicates and summaries. See `docs/M2_DATA_ENTRY_AND_IMPORT.md`.
5. Silent list limits: 500 rows, 200 for tasks/approvals/audit, and 5,000 for purchase counts (which the API's own 1000-row cap would have cut to 1000). **Fixed (uncommitted)** by reading complete lists page by page; UNVERIFIED on the hosted API.
6. Dashboard KPI cards, trends and agent tiles are empty for live organisations; date range and "Custom" are demo behaviour.
7. Per-record activity timelines showed the same global feed in the demo (documented in `UX_FLOWS.md`); live behaviour **UNVERIFIED**.
8. Role matrix is a proposal awaiting client confirmation.

**Security and isolation.** By design and by local test: tenancy via `memberships`, composite `(org_id, id)` foreign keys, `anon` has no table privileges, service-role key unused,
`deny()` on every API handler (static test), same-origin JSON check for writes in required mode, open-redirect-safe `?next=`. Residual risks: Supabase sign-ups were last seen ON; hosted
verification pending; public repository (process control only); `x-forwarded-host` CSRF check unverified behind the real domain.

**Dependencies on the future authenticated deployment:** the `AUTH_MODE`, URL and publishable-key variables; Site URL and redirect settings; sign-ups off; a first owner membership in the real
organisation (`is_demo = false`); the DNS CNAME; the paid plans. See the preparation document.
