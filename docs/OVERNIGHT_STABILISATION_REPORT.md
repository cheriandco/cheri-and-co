# Overnight stabilisation report

Scope: stabilise and test the existing Slices 1 to 4. No new features, agents, tables, migrations, APIs or integrations. B2C Sales and Amazon Intelligence were
not touched. Nothing was committed or pushed. Every result below was produced by running the command named; anything not run is marked **not run** or **UNVERIFIED**.
"Simulated" means a recording fake Supabase client or the in-process Postgres; **nothing was run against hosted Supabase or Vercel**.

## 1. Initial repository and branch state
- Branch `feature/supabase-foundation`, HEAD `ac29323` (`feat: connect live orders and sales reporting`); earlier commits `a28d07f`, `28a4708`, `386707d`, `3a7706a` intact. `main` untouched (`84795ec`).
- Working tree at start: two untracked documents (`docs/APP_DEPLOYMENT_PREPARATION.md`, `docs/FINAL_DELIVERY_ROADMAP.md`), both preserved and only edited where facts changed.
- Docs read: deployment preparation, roadmap, `DATABASE.md`, `API.md`, `UX_FLOWS.md`, `BUSINESS_CONTEXT.md`, `PHASE1_UI_FREEZE.md`, `SUPABASE_SETUP.md`.

## 2. Tests executed and exact results
| Command | When | Result |
|---|---|---|
| `npx vitest run` | start (baseline) | 8 files, **286 passed**, 0 failed |
| `npx vitest run` | after the fixes (final) | 8 files, **312 passed**, 0 failed |
| Mutation check: old versions of the 4 route files, `interactive.tsx` and `live.ts` temporarily restored, new tests run | during the sprint | 14 of the new tests failed on the old code (12 on real behaviour; the 2 paging unit tests only because a stub replaced the helper), then the fixed files were put back and the suite re-run green |
| Demo smoke test: production build served with `AUTH_MODE` unset on a temporary port | after the build | `/tasks` 200 with 5 assignee `<select>` pickers; `PATCH /api/tasks/t1 {assignee}` changed the assignee; `/settings` 200; `GET /api/orders` `[]`; `POST /api/tasks` 201. Server stopped afterwards |

The new tests are **simulated** (fake client or in-process Postgres). They prove application logic, not hosted behaviour.

## 3. Build, lint, typecheck
- `npx tsc --noEmit`: exit 0, no output (start and final).
- `npx eslint .`: exit 0, no output (start and final).
- `npm run build` (Next.js 16.4.1, Turbopack): exit 0, all routes compiled (start and final). The only warnings seen in the Git output were line-ending notices (LF to CRLF), not build warnings.

## 4. Bugs discovered
| # | Defect | How reproduced | Root cause |
|---|---|---|---|
| A | An RLS refusal on a task create/update, a pipeline move or an approval decision answered **500** | New tests: refusal from the fake client gave an unhandled `AuthError` | Older routes did not pass the data layer's error through `errorResponse` |
| B | Live Tasks screen showed the demo's hard-coded name picker (Anika, Dev, Meera) and reported "Reassigned" although nothing was saved. (A narrower claim in the earlier roadmap, that live code stored "Anika", was wrong: live creation never stored an assignee.) | Rendering `TaskList` for a live list; PATCH with `assignee` returned the task unchanged | The table stores a person id and the app has no person picker; the UI and `liveUpdateTask` ignored the mismatch. A patch containing only an assignee returned 404 |
| B2 | **Postpone cleared the due date** of a live task | PATCH `due: "Postponed +1 day"`: `parseDue` could not parse it, so `due_at` became null | The UI sends a demo label; the live path parsed it as a date |
| C | **Silent list truncation, worse than the 500-row limit**: `.limit(5000)` and `.limit(10000)` are capped by the API's own max-rows (1000 by default), so purchase counts and the **Sales report** could be wrong without any error (the Sales report's "too many rows" guard could never fire). Lists also stopped at 500 (200 for tasks, approvals, audit) | Fake client emulating a 1000-row cap: 2,500 orders gave 1,000 | Single bounded query instead of paging. The 1000 default is Supabase's documented default; **UNVERIFIED** on this project |
| D | Stale Settings text ("agent data is still SAMPLE") and stale opening of `SUPABASE_SETUP.md`; `DATABASE.md` and `API.md` still said no database / no authentication | Read | Text not updated after the slices |
| F | **Human-approval bypass at the data level**: a writer (staff) who calls the database directly can set `content_items.status = 'approved'` (or `published`) with no approval, or point `approval_id` at another post's approved approval, and the app showed the post as approved | New tests: such rows showed `approved` | Status/link were trusted without proving the approval belongs to that post. RLS lets writers update `content_items` |
| G | `purchaseCounts` ignored a database error and would show zero purchases | Code review | Error not checked |
| H | An unreadable approvals lookup left posts looking as their stored status | Code review | Error ignored |

## 5. Bugs fixed (all uncommitted)
A, B, B2, C, D, F, G, H as above. Approach in one line each:
- **A:** `try/catch` with `errorResponse` in the tasks POST/PATCH, pipeline PATCH and approvals routes; refusal gives 403, a clash 409, any other failure is still a 500.
- **B:** `TaskList` takes a `live` flag and shows the assignee as text; the live API answers **409** to an assignee change instead of faking success. The demo is unchanged.
- **B2:** `POSTPONE_LABEL`; `liveUpdateTask` moves the stored due date one day later (or one day from now if none).
- **C:** new `allRows()` pages by `range` in steps of 1000 with a stable `id` tiebreak. Used for tasks, approvals, audit, customers, purchase counts, retailers, leads, products, content posts, orders and the Sales report. A list over 10,000 rows is an **error**, never a short list. The activity feed deliberately remains "latest 50".
- **D:** Settings text, `SUPABASE_SETUP.md`, `DATABASE.md`, `API.md` (new section 7).
- **F:** each content approval now records `meta.postId` at submit; a post is approved or rejected only when an approval naming that same post says so, otherwise it shows as a draft.
- **G, H:** errors are now raised.

## 6. Files changed
Source: `src/services/live.ts`, `src/services/live-map.ts`, `src/app/api/[resource]/route.ts`, `src/app/api/[resource]/[id]/route.ts`, `src/app/api/approvals/[id]/[action]/route.ts`, `src/components/interactive.tsx`, `src/app/(app)/tasks/page.tsx`, `src/app/(app)/crm/page.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/settings/page.tsx`.
Tests: `tests/live-data.test.ts` (extended fake client with `range` and a max-rows emulation; new suites), `tests/auth.test.ts` (fake gained `range`).
Docs: `docs/SUPABASE_SETUP.md`, `docs/DATABASE.md`, `docs/API.md`, `docs/APP_DEPLOYMENT_PREPARATION.md`, `docs/FINAL_DELIVERY_ROADMAP.md`, this report. Tracked-file diff: 15 files, +379 / -93 (before this report and the two untracked docs).
No schema, migration, RLS policy, dependency, `.env` or deployment setting was changed.

## 7. New or improved test coverage (26 new cases, 286 to 312)
- Refusal to 403 on tasks create/update, pipeline move, approval decide (approve and reject); unrelated DB failure not disguised; viewer refused before any write or RPC; only owner/admin/approver may decide, staff may not.
- Task assignee refusal (409, no write); Postpone semantics; cross-organisation task 404; live task list renders no name picker, demo still does.
- Paging: 2,500 customers with a 1,000-row API cap, exact-one-page boundary, 2,500 orders for purchase counts, 2,500 delivered orders for the Sales report total, 1,200 tasks, hard cap, error propagation (AuthError vs generic).
- Read sweep: every read route (10 collection routes, agent status/activity, Amazon insights, B2B discovery, content calendar, CRM suggestions, dashboard summary, social posts) for a real organisation contains neither sample markers nor another organisation's rows; single-record routes 404 on foreign or sample ids; a user with no membership gets 403 everywhere; a demo organisation still gets sample data.
- Approval integrity: hand-set status, mis-pointed approval, approval without `postId`, and submit records `postId`.
Existing coverage retained: roles per resource, customer/retailer/lead/product/content/order operations, delivered-only revenue and purchase rules, demo isolation.

## 8. Security findings
Verified by reading the code or running tests (simulated):
- Server-side auth: `deny()` is the first call of every API handler (existing static test); organisation comes from the verified session; every query in `live.ts` filters on `org_id` (scripted scan of all `.from()` calls: only `profiles` by id and the `orders` insert, which carries `org_id`, differ).
- Role matrix agrees with the RLS policies in the migration (writers = owner/admin/approver/staff; delete = owner/admin; decide = owner/admin/approver via `decide_approval`).
- Secrets: the service-role key is read only in `src/lib/supabase/admin.ts`, which nothing imports; `.env.local` is git-ignored, only `.env.example` is tracked; an existing test scans for key-shaped strings. No secret printed in this report. No `dangerouslySetInnerHTML`, `eval` or `new Function` in `src`.
- Sample leakage: none found for real organisations across read routes.

Residual risks (not fixed; need decisions or schema):
- Legacy approvals without `meta.postId` no longer approve their post (it shows as a draft); Postpone on an overdue task adds one day to the old due date, so it can stay overdue. Both are also noted in `docs/SUPABASE_SETUP.md`.
1. **Claim guard is app-side only.** An approver calling the `decide_approval` function directly bypasses the prohibited-claims check. Needs a database-side check (schema change).
2. **A writer can edit an already approved post's text directly** in `content_items`; the approved preview and the stored caption can then differ. Needs a trigger (schema change).
3. Writers can insert arbitrary `meta` on approvals; the `postId` check protects display, not the approval content itself.
4. Supabase **sign-ups were last seen ON**; hosted checks pending; `x-forwarded-host` CSRF check unverified behind the real domain.
5. Public repository: process controls only (see the deployment document).

## 9. Five-agent architecture audit (no B2C or Amazon claim)
| Component | Result of this audit |
|---|---|
| B2B Lead | Retailers, leads and pipeline: live reads, create (API) and stage move, org-scoped, role-checked, now 403-safe. Discovery and follow-up drafts remain sample-only and are refused or hidden for real organisations. |
| Content & Marketing | Posts create/edit/submit to a pending approval; claim guard at submit and decide; status now follows only a post-specific approval. Pack generator, brand rules, assets, performance unavailable for real organisations. Social assist is a labelled template, no data used. |
| CRM & Sales Ops | Customers, retailers, tasks, products, orders (API), Sales report: live. No create forms for customers, retailers, tasks, orders. Assignees not stored. |
| Orchestrator | Live counts for CRM, B2B, Content from the same source as the dashboard; B2C and Amazon tiles say "Not connected to the database yet". Recommends only. |
| Dashboard | Approvals, tasks, funnel and top retailers are live; KPI cards, trends, agent tiles and range selector are empty or demo-only for real organisations. |
| Approvals / audit / activity | Decisions only through `decide_approval()` (permission, state and audit row in one step; real actor). Decide-once enforced. Agent actions cannot decide; staff cannot decide. Content cannot reach "approved" without a human decision (after fix F). |
| Demo/live separation | Real organisations see no sample data (sweep test). Demo mode unchanged (existing isolation tests, plus the smoke test above). |
| B2C Sales, Amazon Intelligence | **Not live.** Untouched. |

## 10. Remaining technical limitations
No create forms for customers, retailers, tasks, orders; no import path; assignees not storable; KPI cards empty for live organisations; one organisation per user (oldest membership); six of seven report sections sample-only; no `global-error.tsx`; no password-reset/MFA; Anthropic/Claude, Canva, Instagram, Amazon, Flipkart not connected; row-level paging unverified on the hosted API.

## 11. Items requiring client or owner approval
Schema for conversations/messages and Amazon data (B2C and Amazon live work); database-side claim guard and caption-lock (security findings 1 and 2); create forms/CSV import (M2); a person picker for task assignment; Claude/Canva access; the role matrix; whether `paid` orders count as revenue; turning off sign-ups, creating the staging and production projects, the paid plans and the DNS record (owner actions); committing and pushing these changes.

## 12. Recommended next engineering milestone
Review and commit this sprint as its own commit, then create the staging Supabase project and run roadmap item M1 (real sign-in and the live queries on staging, including the paged reads and the approval round trip) with the single Owner test account. That converts the "simulated" evidence into hosted evidence before any new build.

## 13. Final Git status
```
branch: feature/supabase-foundation, HEAD ac29323 (unchanged), no commit, no push, no merge, no branch switch
 M docs/API.md                     M src/app/(app)/settings/page.tsx   M src/services/live-map.ts
 M docs/DATABASE.md                M src/app/(app)/tasks/page.tsx      M src/services/live.ts
 M docs/SUPABASE_SETUP.md          M src/app/api/[resource]/[id]/route.ts   M tests/auth.test.ts
 M src/app/(app)/crm/page.tsx      M src/app/api/[resource]/route.ts   M tests/live-data.test.ts
 M src/app/(app)/dashboard/page.tsx  M src/app/api/approvals/[id]/[action]/route.ts
 M src/components/interactive.tsx
?? docs/APP_DEPLOYMENT_PREPARATION.md   ?? docs/FINAL_DELIVERY_ROADMAP.md   ?? docs/OVERNIGHT_STABILISATION_REPORT.md
```
Confirmed: no hosted Supabase or Vercel access, no users/organisations/memberships created, no schema/RLS/dependency changes, no B2C or Amazon work, the uncommitted documentation from earlier was preserved.
