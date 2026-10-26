# DATABASE.md — Data model source of truth (draft for review)

**Status: DRAFT. No database exists.** Nothing in this repository is connected to Supabase or any database.
This document describes what is implemented today and what is still undecided. It is **not** an approved schema.
Do not create tables from this document until the open questions below are answered by the client.

Legend used throughout `docs/DATABASE.md`, `docs/API.md` and `docs/UX_FLOWS.md`:

- **Confirmed implementation**: verified in the current code (commit `3b15f34` + the working tree).
- **Requested in original brief**: stated in the original project brief, which was written for the inherited
  IMI TIARA project. **Not** automatically approved for Cheri & Co.
- **Assumption**: my inference; needs confirmation.
- **Open question**: needs a client decision.

## 1. Confirmed implementation

### 1.1 Where data lives today
| Layer | Location | Notes |
|---|---|---|
| Typed models | `src/types/index.ts`, `src/types/b2c-agent.ts` | Plain TypeScript interfaces. No validation library. |
| Mock data | `src/mocks/data.ts`, `src/mocks/catalogue.ts` | **Invented sample data.** Not real products, prices, people or stock. |
| Service boundary | `src/services/index.ts` | Only place that reads mock data; designed to be re-implemented against a database. |
| Mutable state | `src/services/store.ts` | In-memory, held on `globalThis`. **Resets on server restart.** Holds approvals, tasks, pipeline deals and the audit log. |
| Environment | `.env.example` | `DATA_SOURCE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` (all placeholders). **No code reads any environment variable yet.** `.env.example` also mentions `src/services/source.ts`, which does not exist. |

### 1.2 Entities that exist as TypeScript types
Field lists are exactly those in `src/types/index.ts`; types are the only definition, no constraints or keys exist.

| Entity (type) | Fields (implemented) | Mutable at runtime today? |
|---|---|---|
| `User` | name, role, email | No (hardcoded mock user) |
| `Customer` | id, name, instagram, phone, email, city, firstSeen, interests[], amazonClicks, flipkartClicks, purchases | No |
| `Retailer` (B2B lead) | id, business, location, category, score, temperature (HOT/WARM/COLD), status, lastActivity, contact, email, phone, instagram, website, mapsUrl, qualification, stage | No |
| `Deal` (pipeline card) | id, retailerId, business, location, stage, score, owner, updated | **Yes** (stage via `PATCH`) |
| `PipelineStage` | new, qualified, contacted, interested, negotiation, won, lost | n/a |
| `Enquiry` / `Conversation` / `Message` | enquiry: id, customerId, customer, handle, message, time, status, product, handler; message: id, from (customer/ai/human), text, time | No |
| `Product` | id, name, sku, category, price, stock, channels[], status | No |
| `ContentItem` | id, name, platform, type, date, status, tone, reach?, engagement? | No |
| `Approval` | id, title, type, generatedBy (agent key), created, status, preview, tone | **Yes** (approve/reject/edit) |
| `AuditEntry` | id, approvalId, action, actor, at, note? | **Yes** (append-only, in memory) |
| `Task` | id, title, source, due, priority, assignee, status, href | **Yes** (create, complete, postpone, reassign) |
| `Activity` | id, at, actor, text | No |
| `AppNotification` | id, kind, title, detail, time, href | No |
| `BrandRule` | id, title, detail | No |
| `Agent` | key, name, status, lastActivity, actionsToday, latestAction | No |
| Amazon: `AmazonRow`, `AmazonCompetitor`, `AmazonReview`, `AmazonPricing`, `AmazonListing` | see `src/types/index.ts` | No |
| `Kpi`, `FunnelStage`, `TrendPoint`, `ReportSection` | presentation shapes computed from mock data | No |
| `CatalogueProduct` (B2C agent) | id, name, category, style, occasions[], material?, samplePriceInr?, description, imagePath?, purchaseUrl?, availability, isSample:true | No |
| `B2CAgentResult` | enquiry, intent, intentConfidence, preferences, recommendations[], draftResponse, autoAnswerPermitted, escalation, suggestedNextAction, dataSource, messageSent:false | Not stored; returned per request |

### 1.3 Known weaknesses of the current model (do not copy into a schema)
- Times and dates are display strings ("5 min ago", "08 Oct"), not timestamps. The one exception is `AuditEntry.at`, an ISO timestamp written by the server.
- Two unrelated sample product sets exist: 5 products in `src/mocks/data.ts` (dashboard Products page) and 18 `SAMPLE-…` products in `src/mocks/catalogue.ts` (B2C agent). They are both invented and do not match each other.
- `ApprovalStatus` includes `executed`, but nothing sets it today.
- Money is a bare number with no currency field (the sample catalogue is INR by convention only).
- Relationships are by convention: `Deal.retailerId`, `Enquiry.customerId`, `Task.href` (a URL used as a link to a record), `Approval.generatedBy`.
- `Approval.type` and `ContentItem.platform` are fixed string unions inherited from the sample data.
- `Task.href` encodes the related record as a path; a real model needs a typed reference.
- No ownership/tenant concept; one implicit workspace.
- The audit actor is hardcoded ("Anika"). See `docs/PHASE1_UI_FREEZE.md` items 1–2.

## 2. Requested in original brief (IMI TIARA-era, needs Cheri & Co. confirmation)
The original brief listed these conceptual entities. They are **not approved as a schema**:

users, roles, permissions · customers, leads, retailers · conversations, messages · products, product_variants,
product_images · sales_pipeline, pipeline_stages · tasks, follow_ups · content_assets, content_calendar,
brand_assets, brand_rules · amazon_products, amazon_competitors, amazon_reviews, amazon_insights ·
recommendations · approvals · agent_runs, agent_actions · notifications · activity_logs, audit_logs.

Not implemented at all today (no type or code): roles, permissions, product variants, product images,
agent runs, agent actions, recommendations, brand assets, follow-ups as a separate entity, persisted notifications.

## 3. Assumptions (unconfirmed)
1. The CRM database is the single system of record and agents write through it (from the original architecture diagram).
2. Supabase/PostgreSQL will be used (named in the original brief, `.env.example` and the project owner's deployment strategy); the client must own the project. The client's own acceptance of this is not recorded.
3. One workspace (single business) for now; multi-tenancy is not required.
4. Audit rows must be server-written and immutable.

## 4. Open questions (client decisions needed before any schema)
1. Which entities does Cheri & Co. actually need on day one? (Customers? B2B retailers? Both?)
2. Who are the users and what roles/permissions exist (owner, staff, read-only)?
3. Is there a real product catalogue? Source of truth (spreadsheet, Shopify, other)? Do products have variants and images?
4. Currency and tax handling for prices.
5. Is stock tracked in this system, or elsewhere? (The B2C agent currently never states stock.)
6. What customer data may be stored (names, phone, email, Instagram handle) and what are the consent and retention rules?
7. Which channels create conversations (Instagram DMs only, or also WhatsApp, email, web)?
8. Which statuses and pipeline stages are real? (Current stages are inherited.)
9. Is an audit trail legally or contractually required, and for how long?

## 5. Dependencies
- Client-owned Supabase project (not created) and approved region.
- Authentication decision (see `docs/API.md` §5), because row-level security depends on user identity.
- Answers to §4 before any migration is written.
- A migration process and a separate staging database (see the deployment strategy).
