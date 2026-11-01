# API.md — HTTP API source of truth (draft for review)

**Status: DRAFT.** Describes the routes that exist in `src/app/api` today. All of them serve **mock or in-memory
data**. There is **no authentication, no authorisation, no rate limiting and no database**. Do not expose this
server to the public internet in its current form.

See `docs/DATABASE.md` for the legend (confirmed / requested / assumption / open question).

## 1. Confirmed implementation

### 1.1 Conventions
- Next.js App Router route handlers, JSON in and out.
- Input validation is hand-written in `src/lib/validate.ts` (`readJson`, `str`, `isStage`, `isPriority`). Invalid input returns `400`; unknown resources/ids return `404`.
- Handlers call the service layer (`src/services/index.ts`) and never touch mock data directly.
- Errors are `{ "error": "message" }`.
- The actor for audit entries is the hardcoded string "Anika" (`TODO(auth)` in the approvals route).
- Approvals can only be decided while `pending`: a second decision returns `409` and writes no audit entry. (This replaces the earlier behaviour where a rejected approval could still be approved.)
- Known behaviour to fix before any real use: the `range` query parameter is not validated (unknown values behave like `7d`).

### 1.2 Routes
| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/dashboard/summary?range=` | KPIs, funnel, trend, agents, and the dashboard lists | `range`: `today`, `7d`, `30d`, `90d`, `custom`. Only scales four KPI counts (mock behaviour). `custom` behaves like `7d`. |
| `GET /api/leads` | B2B retailer list | Same data as `/api/retailers`. |
| `GET /api/retailers` · `GET /api/retailers/:id` | Retailers | `404` when unknown. |
| `GET /api/customers` · `GET /api/customers/:id` | Customers | `404` when unknown. |
| `GET /api/conversations` | Conversations with messages | No `:id` route. |
| `GET /api/products` | Product list | Sample data. |
| `GET /api/content` · `GET /api/content/calendar` | Content items; calendar returns items that are not yet published | |
| `GET /api/tasks` · `POST /api/tasks` | List / create task | `POST` body: `title` (1–200 chars, required), `due`, `assignee`, `priority` (`high`/`medium`/`low`, default `medium`). Returns `201`. |
| `PATCH /api/tasks/:id` | Update status / due / assignee | `status`: `open`/`done`/`postponed`. |
| `PATCH /api/pipeline/:id` (alias `/api/leads/:id`) | Move a pipeline card | Body `{ "stage": <PipelineStage> }`; id is the **deal** id (`d-<retailerId>`). |
| `GET /api/approvals` | All approvals | |
| `POST /api/approvals/:id/approve` · `/reject` · `/edit` | Decide an approval | Optional `note` (≤500). `edit` requires `title` and/or `preview` (≤6000). Each successful call appends an audit entry. `404` unknown id; `409` already decided; `422` when approving a Content draft that contains prohibited wording. Approving executes, sends and publishes nothing. |
| `GET /api/agents/status` · `GET /api/agents/activity` | Five agents' status; activity log | |
| `GET /api/amazon/insights` | Amazon sample tables | Inherited feature; see §4. |
| `GET /api/reports` | Report sections | Mock numbers. |
| `POST /api/agents/b2c/run` | Run the B2C Sales Agent prototype | Body `{ "enquiry": string }`, 1–1000 chars. Returns a `B2CAgentResult`. **Drafts only: nothing is sent, stored or logged.** `messageSent` is always `false`. |
| `POST /api/agents/content/run` | Draft content for a SAMPLE product or pack | See §1.4. Returns `{ draft, note? }`. **Nothing is stored, sent or published.** |
| `POST /api/agents/content/submit` | Queue a draft for human review | Same body. The server regenerates the draft, then creates a `pending` Content approval. `201`; `404` unknown target; `409` identical draft already pending; `422` blocked draft. |

### 1.3 B2C Sales Agent route contract (`POST /api/agents/b2c/run`)
Response fields (see `src/types/b2c-agent.ts`): `enquiry`, `intent`, `intentConfidence` (0–1, rule-based, not a model
probability), `preferences`, `recommendations[]`, `draftResponse`, `autoAnswerPermitted`, `escalation`
(`required`, `code`, `reason`, `priority`), `suggestedNextAction` (`owner`: agent or human), `dataSource`
(`prototype_sample_catalogue`, `verified: false`), `messageSent: false`.

Intents: product_recommendation, occasion_style_recommendation, price_enquiry, product_details,
availability_enquiry, purchase_link_request, order_status, return_refund, return_policy_enquiry,
shipping_enquiry, discount_enquiry, complaint, other.

Behaviour guarantees (covered by `tests/b2c-agent.test.ts`, 35 tests):
- Never states live stock, order status, delivery promises, discounts, return terms or purchase links; it says the information is unavailable.
- Escalates order status, refunds/returns of existing orders, complaints, unclear enquiries, missing information and no-match cases to a human.
- Prices are labelled as sample prices. All catalogue products are flagged sample data.
- Deterministic and rule-based: no network or model call, no API key used.

### 1.4 Content & Marketing Agent routes
Body for both routes: `{ "targetType": "product" | "pack", "targetId": string, "audience"?: "everyday" | "college" | "work" | "gifting", "amazonUrl"?: string, "flipkartUrl"?: string }`.
Links must be `https` on Amazon or Flipkart hosts (affiliate short links such as `amzn.to` and `dl.flipkart.com` included); they are used verbatim and never generated.
The draft (`ContentDraft`, `src/types/content-agent.ts`) contains the Instagram caption, hashtags, reel script, ASMR script, three story frames, a Canva brief, the marketplace CTAs, `issues`, `blocked`, `factsUsed`, `published: false` and `status: "ai_generated"`.
Rules enforced in code and covered by `tests/content-agent.test.ts`:
- Drafts are template-generated from the record only. They never state prices, discounts, stock, materials or product claims unless a client-approved claim is on the record (price, discount and stock wording is never allowed, even if "approved").
- Blocked drafts (prohibited wording, invalid link, missing name) cannot be submitted, and an edited preview is re-checked on approval.
- Workflow: `ai_generated` → `pending_review` → `approved` | `rejected`. There is no publish state and no outbound call to Instagram, Amazon, Flipkart or any other platform.
- Editing: a pending draft can be edited in Approvals. The edited text is re-checked on approval, so editing cannot bypass the claim guard (`422` if it now contains prohibited wording).
- Claude drafting is **not implemented** (see "Planned Claude integration" below). The reserved flag `CONTENT_AGENT_USE_CLAUDE` (default `false`) only adds a note to the run response saying drafting is still template-based. No Anthropic key is read and no outbound call is made. The earlier GPT switch was removed.

**Status of the Content agent's integrations**
- *Implemented:* template drafting; Canva design brief as text; claim guard; link allowlist; approval workflow with audit trail; in-memory only.
- *Planned:* Claude drafting and refinement; Canva automation; persistence in Supabase.
- *Requires client access or approval:* Anthropic Console API key and usage billing; verified Canva plan and API/automation capability; approved claims, catalogue and marketplace links.

**Planned Claude integration (design only, not built)**
- A Claude Team subscription is not API access. Live drafting needs an Anthropic Console API key and separate usage billing, which the client must decide on and supply through a secrets manager, never in chat or source.
- Calls stay server-side, inside the content-agent service, selected by `chooseGenerator` in `src/lib/content-agent/config.ts` when the flag is on **and** a key is configured. The browser never sees the key, and the key is never logged or returned in a response.
- Claude output would enter the same pipeline as template output: it is a draft (`status: "ai_generated"`, `published: false`), is scanned by the claim guard and link checks, is blocked if it states a price, discount, stock level or unapproved claim, and then follows pending review, edit, approval. Claude would receive only the product or pack record and approved claims, and would be told not to add facts.
- Claude would not be given any tool or credential able to post, send or publish.
- Canva stays a text brief. Any Canva automation is a separate decision after the client's plan and API access are verified.

## 2. Requested in original brief (needs Cheri & Co. confirmation)
The brief listed `GET/POST/PATCH` endpoints for leads, customers, retailers, conversations, products, content,
Amazon insights, tasks, approvals (approve/reject), agent status/activity and reports. The implemented set above
covers the reads; gaps are in §3.

## 3. Gaps vs. the original brief
- No `POST`/`PATCH /api/leads`, no `POST` for customers/retailers/conversations/products.
- No `GET /api/conversations/:id`; no pagination, sorting or filtering parameters (the brief asked for pagination and server-side filtering).
- No `GET /api/agents/runs` or action endpoints; no orchestration.
- No webhook or inbound endpoints (Instagram, Amazon, Flipkart).

## 4. Assumptions
1. Auth will use session-based identity so the actor is derived server-side, never from the request body.
2. Endpoints will move behind authorisation by role, with input validated server-side.
3. The service layer remains the only place that changes when moving from mock to a database.

## 4a. Social media demo endpoints (Content & Marketing Agent)
Demo only: every call works on the visitor's private in-memory copy and nothing is posted to any platform.
- `GET /api/social/posts`: sample posts plus the visitor's own.
- `POST /api/social/posts`: create a draft (Instagram, Facebook or LinkedIn). 201, or 400 on invalid input.
- `POST /api/social/posts/:id/edit`: edit a draft or rejected post (409 otherwise).
- `POST /api/social/posts/:id/submit`: queue the post as a pending approval. 422 if the claim guard finds prices, offers or stock claims; 409 unless a draft.
- `POST /api/social/posts/:id/publish`: "simulate publish" an approved post (409 otherwise). Attaches SAMPLE metrics.
- `POST /api/social/assist`: template-based ideas, captions and creative briefs, labelled "DEMO RESPONSE". No AI model is called.
Status follows the linked approval: pending, approved, rejected. Decisions are made through the existing `/api/approvals/:id/:action`.

## 4b. Cross-agent demo endpoints
Demo only. Every call works on the visitor's private in-memory copy. Nothing is sent, posted or changed anywhere.
- `POST /api/agent-actions {agent: b2c|b2b|amazon, ref}`: queues the agent's suggestion in Approvals (201; 409 if already pending; 404 unknown record). The text is rebuilt on the server from sample records.
- `GET /api/b2b/discover`: fixed SAMPLE retailer candidates with rule-based fit scores. `POST {id}` adds one to the visitor's leads and pipeline.
- `GET /api/crm/suggestions`: rule-based next actions. `POST {key}` creates a task from one.
- `GET /api/orchestrator/brief`: cross-agent summary (per-agent headline, pending approvals, recommendations, latest activity). Read-only.

## 5. Open questions
1. Authentication method (email/password, magic link, SSO) and who the first users are.
2. Roles and which actions each may take (e.g. who may approve or reject).
3. Pagination/filter requirements and expected data volumes.
4. Which integrations are real for Cheri & Co. (see `docs/UX_FLOWS.md` §5) and what inbound webhooks they need.
5. Rate limiting and abuse protection requirements for the public deployment.
6. API versioning and whether a public API is ever required.

## 6. Dependencies
Authentication and database decisions (`docs/DATABASE.md`); a staging environment; client-owned accounts for any integration.
Security note: the Next.js version is 16.4.1 (patched for GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r).
