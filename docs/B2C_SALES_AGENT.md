# B2C Sales Agent: enquiries, replies and follow-ups (Milestone 3, backend)

Status: **implemented and tested locally; the database migration is NOT applied.** Until the owner applies
`supabase/migrations/20261114000000_b2c_enquiries.sql`, every enquiry endpoint answers **503 "not set up yet"**. No UI was built (a separate design resource owns that).

## What it does

1. **Enquiries.** A team member logs what a customer asked (source, message, optional customer, optional product). Stored per organisation.
2. **Recommendations.** Deterministic matching of the enquiry against the organisation's own `products` rows (no AI). Every result names the catalogue fields it matched on and carries only recorded values (name, category, description, status, price/stock as stored or `null`). Archived products are never offered; a stated budget excludes dearer or unpriced products; known-zero-stock products are not offered unprompted.
3. **Reply drafts.** A template reply by default. If `AI_ENABLED=true` (off by default) and every existing gate passes (live org, prices configured, key present, spend/day/minute limits), the wording is written by OpenAI through the existing `callStructured` path. Either way the result is only a **draft**.
4. **Conversation history.** `enquiries` + `enquiry_messages` (direction, body, status, related product, approval link, author = customer/human/template/ai, model, timestamps, org id).
5. **Human approval.** Submitting a draft creates a pending approval (type `B2C Reply`, `meta.kind = "b2c_reply"`) in the existing Approval Centre. Only an approver decision moves it to approved/rejected; the claim guard re-runs on approval.
6. **Follow-ups.** A row in the existing `tasks` table (`source = "B2C enquiry"`, `related_ref = "/b2c?enquiry=<id>"`) with due date, reason, priority, optional assignee (must be a member of the organisation). One open follow-up per enquiry; history is kept in `agent_activity` (`ref_type = "enquiry"`).

## What it deliberately does not do

- It **never sends** anything to a customer: no WhatsApp, SMS or email integration exists. "Approved" means a person approved the wording. A person may record `mark-sent` (only when the message carries an approval of this organisation, of type `B2C Reply`, that says approved; the database refuses it otherwise) to note that they sent it themselves, outside the app. `OutboundChannel` in `src/types/enquiry.ts` is an unimplemented seam; nothing calls it.
- It never states a price, discount, stock level, material, certification or other claim in a draft (claim guard on the template, on AI text, on edits, on submit and on approval; AI text that fails is discarded, not edited).
- It sends **nothing the customer wrote** to OpenAI. Names in free text cannot be reliably detected, so the model receives only: brand facts, the detected intent, closed-vocabulary keywords (category/style/occasion/budget band) and the matched product records (name, category, owner description), redacted for emails/phones/links/handles. No customer record is read for a reply, and no ids, prices or stock figures are sent.
- Complaints, refunds/returns and order-status messages get a holding reply and **never an AI call**; `context.needsHuman` is returned.

## Database (proposed, not applied)

`supabase/migrations/20261114000000_b2c_enquiries.sql` adds two tables, their triggers and two functions. The only thing it attaches to an existing table is ONE trigger on `approvals`, limited by `WHEN (new.type = 'B2C Reply')`; no existing policy, grant or column changes.

| Object | Purpose |
|---|---|
| `enquiries` | one per customer enquiry; `source`/`status` checks; composite FKs `(org_id, customer_id)`, `(org_id, product_id)` (`on delete set null`); `created_by` is forced to `auth.uid()`; `updated_at` maintained |
| `enquiry_messages` | the conversation; inbound is always `received`; outbound is born a draft; body 1..6000 (matches `approvals.preview`); composite FKs to enquiry (cascade), product and approval |
| `private.guard_enquiry_message()` (BEFORE INSERT/UPDATE) | **the workflow lives here.** Inbound messages are immutable. A reply moves only draft → pending_approval → approved \| rejected, rejected → draft, approved → sent_manually. Each step into pending/approved/rejected/sent needs an approval of the same organisation, type `B2C Reply`, in the matching state, whose preview equals the message body. Once pending/approved/sent the approval link and the content are frozen (the one body change allowed while pending is the copy of an approver's own edit). `created_by`, `created_at`, ids and direction never change. |
| `private.guard_enquiry()` / `refresh_enquiry_status()` | the enquiry status is derived from the latest reply by trigger; a person may only close (not while a reply is pending) or reopen to what the replies imply |
| `b2c_reply_sync` on `approvals` (AFTER UPDATE, reply approvals only) | copies an approver's decision and any edited wording onto the message in the SAME transaction as `decide_approval()`; there is no best-effort step in the application any more |
| `create_b2c_enquiry()` | enquiry + first message in one transaction; the same message/source/customer within 10 minutes returns the existing enquiry (advisory lock) |
| `submit_b2c_reply()` | locks the message, refuses if the text differs from what the caller reviewed, builds the approval FROM the locked text, links it; repeating it returns the same approval |
| partial unique index `enquiry_messages_one_live_reply` | one draft or pending reply per enquiry; rejected, approved and sent replies are history and never block a new draft |
| indexes | every foreign key has a covering index; `(org_id, approval_id)` is unique (one approval, one message) |

RLS matches every other tenant table: read = member, insert/update = owner/admin/approver/staff; `anon` has no access. The triggers add the state rules RLS cannot express, and apply to every role.

**Hard deletion is intentionally unsupported for enquiry conversations** (owner decision: keep the whole conversation and its approval history). `BEFORE DELETE` triggers refuse deleting any message (inbound or outbound, any status) and refuse deleting an enquiry that still has messages, for every role including the table owner, with the plain message *"Enquiry messages cannot be deleted: the conversation and its approval history are kept. Close the enquiry instead."* The delete policy and grant are left in place on purpose so a prohibited attempt gets that message rather than a bare permission error (staff, approver and viewer are filtered out by row level security and delete nothing). Use close/reopen for lifecycle. The only exception is deleting an entire organisation, which removes everything it owns by cascade. There is no archive or soft-delete in this milestone, and approvals and `audit_log` are not touched (users already cannot delete them). Deleting a product, customer or user still works (the link is set to null).

**Internal helpers are not callable by application users.** The seven `private.*` functions this migration adds (`enquiry_derived_status`, `refresh_enquiry_status`, `guard_enquiry`, `guard_enquiry_message`, `guard_enquiry_message_delete`, `guard_enquiry_delete`, `sync_b2c_reply`) have EXECUTE revoked from PUBLIC, anon and authenticated (without this, any signed-in user could read another organisation's enquiry status through `enquiry_derived_status`). Triggers fire regardless, because trigger functions are checked for EXECUTE only when the trigger is created. Only `create_b2c_enquiry` and `submit_b2c_reply` are granted to `authenticated`.
Verified against the real SQL in PGlite: `tests/rls.test.ts` (isolation) and `tests/b2c-enquiry-db.test.ts` (the bypasses, the legitimate flow, atomicity, indexes, rollback). The same attack scripts run against the pre-remediation schema (`tests/fixtures/b2c_enquiries_audit_baseline.sql`) and succeed there.

**Rollback** (statements are in the migration header, tested): drop the `approvals` trigger and function, both RPCs, both tables and the helper functions. The header also lists the optional cleanup of what the feature leaves in existing tables (reply approvals, follow-up tasks, activity lines, customers created through enquiries).

## API (all JSON; writes need same-site JSON and permission `enquiries:write` = owner/admin/approver/staff; reads need membership)

| Method and path | Purpose |
|---|---|
| `GET /api/b2c/enquiries?limit=&offset=&status=&customerId=` | list, newest activity first. `limit` 1..100 (default 50); response `{data, page:{limit,offset,hasMore}}` |
| `POST /api/b2c/enquiries` `{source, message, productId?, customerId? \| customer?:{name, email?, phone?, instagram?, city?}}` | log an enquiry (201, `{data, customer:{id,created}\|null, warning?}`). `customer` finds an existing customer of this organisation by EXACT email (lower-case), phone (digits) or Instagram handle, else creates one through the CRM's own path after the enquiry exists. `warning` appears if the customer could not be saved or linked. The same message from the same customer on the same channel within 10 minutes is a 409 with `existingId` |
| `GET /api/b2c/enquiries/:id/messages?limit=&offset=` | the conversation, oldest first, paged; each message shows its real approval status |
| `GET /api/b2c/enquiries/:id` | enquiry + messages (status follows the approval) + follow-ups + history |
| `POST /api/b2c/enquiries/:id/recommendations` `{productId?}` | catalogue matches (nothing saved) |
| `POST /api/b2c/enquiries/:id/reply` `{productId?}` | create or regenerate the single open draft |
| `POST /api/b2c/enquiries/:id/follow-up` `{dueDate, reason, assigneeId?, priority?}` | create the follow-up (201; 409 if one is open) |
| `PATCH /api/b2c/enquiries/:id/follow-ups/:fid` `{status?, dueDate?, priority?, reason?}` | update a follow-up (`open`/`done`/`postponed`); at most one may be open |
| `POST /api/b2c/enquiries/:id/follow-ups/:fid/complete` | mark the follow-up done (409 if already done) |
| `POST /api/b2c/enquiries/:id/(close\|reopen)` | close (blocked while a reply waits in Approvals) or reopen to the status its latest reply implies |
| `POST /api/b2c/enquiries/:id/messages/:mid/edit` `{body}` | person's edit of a draft or rejected reply (1..6000 characters; refused once pending, approved or sent) |
| `POST /api/b2c/enquiries/:id/messages/:mid/submit` | send the draft to Approvals (atomic; repeating it returns the same approval with `alreadySubmitted: true`; 409 if the text changed since it was read) |
| `POST /api/b2c/enquiries/:id/messages/:mid/mark-sent` | record a manual send of an approved reply |

Errors: 400 invalid input, 403 role/cross-site, 404 not found or other organisation, 409 wrong state/duplicate, 422 claim-guard or non-member assignee, 503 migration not applied, 500 (JSON, logged) for real faults.
Modified: `liveDecideApproval` (claim guard for `b2c_reply`; the status sync is the database trigger), `Approval` types, role matrix (`enquiries:write`). `POST /api/agents/b2c/run` is unchanged (it still serves the demo and answers 501 to live organisations, so the existing page is not broken).

## Scenarios, customer matching and catalogue facts (added after the first backend pass)

- **Scenarios** (`context.scenario`): `product_enquiry`, `comparison`, `purchase_intent`, `general`, `needs_human` (complaint, refund, order status: always wins, never reaches AI). Comparison and purchase-intent are detected from wording and sent to AI only as the closed keywords `comparison` / `ready to buy`. A comparison draft lists each matched product with its recorded category and first description sentence; a purchase-intent draft thanks the customer and says a person will confirm the details. No price, stock, payment detail, order confirmation or date is ever written; the claim guard still scans the final text.
- **Recommendations** carry `imageUrl` and `catalogueGaps` (no description / image / category / price / stock recorded). The endpoints also return `catalogueNotes` for the reviewer (nothing matched; only one product to compare; a matched product missing a description or image). Nothing is filled in.
- **Customer matching** is exact equality on normalised values: email lower-case, Instagram lower-case without "@", phone compared as digits (so "+91 98765 43210" and "+919876543210" match; "98765 43210" without the country code does not). `* % \\` are refused in any contact detail, and no pattern matching is used. Validation reuses the CRM's `parseCustomerInput` (same limits as the Customers page); the customer is created with the CRM's `liveCreateCustomer` (same activity line). Limits: a customer created elsewhere with an upper-case email will not match an enquiry's lower-case email, and two simultaneous first-time submissions for a customer who is not on file could still create two customer rows (`customers` has no unique constraint).
- **Duplicate guard** is decided inside `create_b2c_enquiry` under an advisory lock (10-minute window on identical message text + channel + customer or none).
- AI prompt version is now `b2c-reply-v2`.

## Known limitations

- Recommendations are keyword/field matching, not semantic search; there are no style tags or approved claims for live products.
- Follow-up completion is handled through the existing Tasks page (status on the task); the enquiry view just reads it.
- Not verified against the hosted Supabase project (migration not applied) or a live OpenAI call (not approved).
- **Concurrency** was verified on a disposable PostgreSQL 18.6 with four independent connections (simultaneous submit, edit versus submit, duplicate drafts, approve versus reject, retries, rollback; including forced lock-wait orders), not only in PGlite. The scripts live outside the repository (scratch folder); the in-repo PGlite suite proves the rules and idempotency but not parallel lock behaviour. The hosted Supabase project has not been tested.
- Hard deletion of enquiry messages and of enquiries that have messages is blocked by design (see Database). A superuser can still drop the trigger or truncate the tables; no application role can.
- A user with write access can create their own pending reply approval and link it (it still needs an approver to approve, and its text must equal the message).

## Applying it (owner)

Paste the migration into the Supabase SQL Editor, then smoke-test: create an enquiry, draft a reply (template), submit, approve in Approvals, `mark-sent`.
