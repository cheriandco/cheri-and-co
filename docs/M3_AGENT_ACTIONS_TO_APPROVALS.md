# M3: agent actions to Approvals (B2B live; B2C and Amazon not connected)

Status: **implemented on `feature/client-delivery` (local, uncommitted). Verified only with local tests (a recording fake of the database). NOT verified against a hosted Supabase project, RLS or the real `decide_approval()`** (no staging project exists; M1).

Scope was agreed as: **B2B live; B2C and Amazon stay "not connected"** in a real organisation. They have no real data source (no live conversations, no Amazon rows), and inventing one would put made-up text in front of an approver. M6 (richer B2B drafts) is later.

No migration, table, policy, function or dependency was added. It works with the foundation migration alone.

## What a user sees

- A real organisation's **retailer page** shows "Recommended follow-up" and a **Draft follow-up email** button to roles that may run agents (owner, admin, approver, staff). Viewers do not see it.
- The button creates a **pending approval** (type "B2B outreach", from the B2B agent) in Approvals. The page then shows "Pending approval", and afterwards "Approved" or "Rejected".
- The draft is a **plain template**, not AI-written: greeting, the stage-based reason, and a bracketed line "[Add the products, prices and terms here before sending. Nothing has been sent.]". It has no SAMPLE wording, prices, terms or product claims. The reviewer can edit it before approving.
- **Nothing is sent.** Approving only marks the approval approved (as for content posts). There is no email, WhatsApp or other delivery in this app yet.

## Rules enforced

| Rule | Where |
|---|---|
| The organisation comes from the session; the browser sends only the retailer id, never text or an organisation | `liveQueueB2bFollowUp` in `src/services/live.ts` |
| The retailer must belong to the organisation (else 404) | same function, `org_id` filter |
| Text is built on the server from the saved record | `liveFollowUpDraft` in `src/lib/agent-logic.ts` |
| Claim scan at queue time (422, nothing written) and again at approval | same function; `liveDecideApproval` now scans `b2b_followup` approvals as well as content drafts (demo too) |
| A retailer with a pending follow-up cannot be queued again (409); after a decision it can | `pendingAgentActions` reads pending approvals and their `meta.agent` / `meta.ref` |
| Who submitted it | recorded in the activity history (`agent_activity.actor_id`); approvals have no created-by column and none was added |
| A decision writes an audit row | `decide_approval()` (database function) as before, with the signed-in user as actor |
| B2C and Amazon in a real organisation | 404 "not connected to a data source yet"; nothing written |
| Permission | `agents:run` plus the cross-site check; the database write is also bound by RLS (`can_write`) |

## Limitations (honest list)

- **Not run against a real database.** RLS on `approvals`, `decide_approval()` and the audit row are exercised only by the staging run (M1). The tests prove the application logic and that decisions go through `decide_approval`.
- **Duplicate refusal is application-level.** Without a unique constraint (that would need a migration), two simultaneous clicks could both pass the check and create two pending approvals. A person rejects the extra one. A later migration could add a partial unique index.
- **Nothing is delivered.** Approval is the end of the road today; sending is a separate milestone and a client decision.
- The template is generic. Product, price and terms text is supplied by the team in the edit step; richer drafts are M6.
- Lookup is by retailer id from the page. The "suggestions" list on the CRM page and task creation from suggestions still say "not connected" for real organisations.
- If the hardening migration (separate branch) is ever combined with this branch, approval creation here uses only a plain pending insert, which it permits; this was not tested against it.

## Files

New: `docs/M3_AGENT_ACTIONS_TO_APPROVALS.md`, `tests/m3-api.test.ts` (15 tests).
Changed: `src/services/live.ts`, `src/services/index.ts`, `src/lib/agent-logic.ts`, `src/types/index.ts`, `src/app/api/agent-actions/route.ts`, `src/components/agent-actions.tsx`, `src/app/(app)/retailers/[id]/page.tsx`, `docs/API.md`, `docs/FINAL_DELIVERY_ROADMAP.md`.
