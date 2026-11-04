# M4: B2C Sales from customers and orders

Status: **implemented on `feature/client-delivery` (local, uncommitted). Verified only with local tests (a recording fake of the database). NOT verified against a hosted Supabase project, RLS or the real `decide_approval()`** (no staging project exists; M1).

This is the **customer- and order-based** M4 that was approved. The roadmap's older conversation-based M4 (stored Instagram enquiries, new tables, migration) is **not** built. No migration, table, policy or dependency was added; it works with the foundation migration alone.

## What a user sees

- For a real organisation the **B2C Sales** page lists *follow-up opportunities* found from its own saved customers and orders, each with a plain reason ("Latest delivered order is about 45 days old"). Sample conversations never appear. The demo page is unchanged.
- A permanent banner reads **"Consent not recorded — verify permission before contacting."** The app does not know whether a customer agreed to be contacted, and approving a draft is **not** proof that they did.
- **Draft follow-up** (owner, admin, approver, staff) creates a pending approval labelled **"B2C Follow-up"**. Each such approval shows a "Consent not recorded" badge in Approvals. The draft starts with an internal note (delete before sending) repeating the warning.
- **Nothing is sent.** There is no email, WhatsApp or Instagram integration. Approving only records the decision; a person checks permission and sends outside the app.

## Provisional opportunity rules (client must confirm before operational use)

Every rule looks at the customer's **most recent order** only, so a customer has **at most one opportunity**, tied to one order, and categories cannot overlap. Days are whole days, counted from the **order date**.

**Post-delivery check-in is switched off.** The approved rule (delivered 3 to 10 days ago) needs a real delivery date, but the database records only when an order was placed (`orders.ordered_at`); there is no delivery timestamp, and `status = delivered` does not say when. Counting from the order date could send a "hope it arrived" message before the parcel reaches the customer, so no check-in opportunity is produced at all, and a delivered order that is 0 to 29 days old is simply not an opportunity. It can be enabled only after a genuine delivery timestamp is stored (a future, separately approved change that would need a database column).

| Latest order | Opportunity |
|---|---|
| returned or cancelled | **Needs human review**: flag only, no draft, no sales nudge |
| status `new` for more than 3 days | Order still new (unpaid) |
| delivered 30 to 90 days ago | Repeat-purchase nudge |
| delivered more than 90 days ago | Win-back |
| delivered 0 to 29 days ago (**no post-delivery check-in**, see above); `paid` or `shipped`; `new` for 3 days or less; no orders; dated in the future | none |

Consequences worth knowing: a delivery in the last 29 days hides an older order's win-back (the customer just ordered); a later returned order suppresses nudges based on an older delivery; a newer paid/shipped order suppresses win-back and repeat nudges; an older returned order that is *not* the latest does not block a nudge on a newer delivered order. A customer with **no usable email or phone** (a plausible email, or a phone with 6 or more digits) is flagged "contact incomplete" and cannot be drafted for.

The thresholds are in one place (`THRESHOLDS` in `src/lib/b2c-opportunities.ts`).

## The draft

Built on the server from the saved customer (name, email, phone). The browser sends only the customer id. It is a **template, not AI-written**: a short greeting and one or two generic sentences per category, a placeholder "[Add client-approved products or offer here, if any.]", and no price, discount, stock, product or purchase detail. It passes the shared claim scan.

## Rules enforced

| Rule | Where |
|---|---|
| Organisation from the session; customer and its orders read with the organisation filter; unknown or other-organisation customer is 404 | `liveQueueB2cFollowUp` in `src/services/live.ts` |
| Opportunity recomputed on the server at queue time; none, returned/cancelled or no contact is 409 and nothing is written | same |
| Claim scan at queue time (422) and again at approval (any `b2c_followup` approval, live and demo) | same; `liveDecideApproval`, `decideApproval` |
| One pending follow-up per customer (409); a decided one does not block | `pendingAgentActions` (shared with B2B) |
| Who queued it | activity history (`agent_activity.actor_id`); approvals have no created-by column |
| A decision writes an audit row | `decide_approval()` as before |
| Permission | `agents:run` (owner, admin, approver, staff) plus the cross-site check; viewers are 403 |
| Amazon | still 404 "not connected" |
| Dashboard | the B2C headline counts opportunities ("N customer follow-up opportunities to review"); a failure to compute them shows "unavailable" instead of breaking the dashboard |

## Limitations (honest list)

- **Not run against a real database.** RLS on `approvals`, `decide_approval()` and the audit row are exercised only by the staging run (M1).
- **Thresholds are provisional defaults**, not learned from data and not yet confirmed by the client.
- **No delivery date is recorded, so there is no post-delivery check-in.** The repeat-purchase (30 to 90 days) and win-back (over 90 days) rules still count from the order date. With ranges that wide the error is small, but the thresholds are provisional anyway. A delivered order newer than 30 days produces nothing.
- **No consent or opt-out data exists.** Everything is a suggestion to a person. A customer who has opted out cannot be excluded by the app.
- **Duplicate refusal is application-level.** Two simultaneous clicks could both pass the check (no unique constraint without a migration); a person rejects the extra one.
- **Only the latest order is considered**, and drafts do not mention what was bought (`line_items` is free-form).
- **The whole organisation is read** (customers and orders, up to the existing 10,000-row cap) each time the B2C page or dashboard loads. Fine for a small business; a very large one would need a database query.
- Inbound enquiries, conversations, Instagram/WhatsApp/email sending, product recommendations and Amazon are out of scope.
- The Approvals badge still says "AI-generated draft" for all templated drafts (existing behaviour, also for B2B).

## Files

New: `src/lib/b2c-opportunities.ts`, `tests/b2c-opportunities.test.ts` (27), `tests/m4-api.test.ts` (21), `docs/M4_B2C_SALES.md`.
Changed: `src/services/live.ts`, `src/services/index.ts`, `src/types/index.ts`, `src/app/(app)/b2c/page.tsx`, `src/components/interactive.tsx` (consent badge), `tests/m3-api.test.ts` and `tests/live-data.test.ts` (two assertions that encoded "B2C not connected"), `docs/API.md`, `docs/FINAL_DELIVERY_ROADMAP.md`.
