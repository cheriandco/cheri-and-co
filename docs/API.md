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
- Known behaviours to fix before any real use: the approvals route does not check the current status (a rejected approval can still be approved, and each call adds an audit entry); the `range` query parameter is not validated (unknown values behave like `7d`).

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
| `POST /api/approvals/:id/approve` · `/reject` · `/edit` | Decide an approval | Optional `note` (≤500). `edit` requires `title` and/or `preview`. Every call appends an audit entry. |
| `GET /api/agents/status` · `GET /api/agents/activity` | Five agents' status; activity log | |
| `GET /api/amazon/insights` | Amazon sample tables | Inherited feature; see §4. |
| `GET /api/reports` | Report sections | Mock numbers. |
| `POST /api/agents/b2c/run` | Run the B2C Sales Agent prototype | Body `{ "enquiry": string }`, 1–1000 chars. Returns a `B2CAgentResult`. **Drafts only: nothing is sent, stored or logged.** `messageSent` is always `false`. |

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
- Deterministic and rule-based: no network or model call, no OpenAI key used.

## 2. Requested in original brief (needs Cheri & Co. confirmation)
The brief listed `GET/POST/PATCH` endpoints for leads, customers, retailers, conversations, products, content,
Amazon insights, tasks, approvals (approve/reject), agent status/activity and reports. The implemented set above
covers the reads; gaps are in §3.

## 3. Gaps vs. the original brief
- No `POST`/`PATCH /api/leads`, no `POST` for customers/retailers/conversations/products.
- No `GET /api/conversations/:id`; no pagination, sorting or filtering parameters (the brief asked for pagination and server-side filtering).
- No `GET /api/agents/runs` or action endpoints; no orchestration.
- No webhook or inbound endpoints (Instagram, Amazon, Higgsfield).

## 4. Assumptions
1. Auth will use session-based identity so the actor is derived server-side, never from the request body.
2. Endpoints will move behind authorisation by role, with input validated server-side.
3. The service layer remains the only place that changes when moving from mock to a database.

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
