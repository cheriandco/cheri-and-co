# Staging setup and hosted verification (M1)

**Status: PREPARED. NOT EXECUTED. M1 is NOT complete.**
No staging project exists, none was created, and no hosted service was contacted while preparing this document. Every result quoted in the
repository so far comes from local fakes or from an in-process Postgres, except one owner-reported run of `docs/rls_live_check.sql` (95/95 PASS)
on the existing project, which predates Slices 2 to 4 and the security hardening migration. Nothing below may be reported as hosted verification
until it has actually been run on a staging project and its output kept.

Related: `docs/APP_DEPLOYMENT_PREPARATION.md` (hosting decisions), `docs/SECURITY_HARDENING_REPORT.md`, `docs/CLIENT_SCOPE_SIGNOFF.md`.

---

## 1. What is missing before M1 can start (exact list)

| # | Missing | Who | Note |
|---|---|---|---|
| 1 | **Written go-ahead** to create a separate staging Supabase project | Project owner / client | No hosted infrastructure is created without it. |
| 2 | **A staging Supabase project** (empty, separate from `ciodkacwdbktuimriuss`) | Project owner (billing owner) | Plan choice and billing are the owner's. Free is acceptable for a short staging test but pauses after inactivity. |
| 3 | **Staging project URL and anon key**, placed only in a git-ignored local file or the staging Vercel project | Project owner | Never in chat, never in git (the repository is public). The service-role key is **not** needed and must not be set. |
| 4 | **One staging Owner user** created in the staging project's Auth dashboard, with a password the owner keeps | Project owner | Decision: one Owner account only (section 4). |
| 5 | **Approval to apply both migrations to staging** | Project owner | Section 3. |
| 6 | (Later, for M7 not M1) separate staging Vercel project and release branch | Project owner | `docs/APP_DEPLOYMENT_PREPARATION.md`. |

The existing project `ciodkacwdbktuimriuss` is the client's real project. It is **not** staging. Do not run the verification scripts there and do not apply
the hardening migration there until staging has passed and the owner approves.

---

## 2. Isolation rules for staging

- A **separate Supabase project**: its own URL, anon key, database, Auth users and data. No shared credentials with `ciodkacwdbktuimriuss`.
- **Separate environment variables.** Local runs use a staging file such as `.env.staging.local` (the pattern `.env*.local` is already git-ignored), never `.env.local`,
  which currently points at the existing project. A staging Vercel project has its own variables; the production project's variables are never copied across.
- **Separate Auth users.** The staging Owner exists only in staging.
- **Separate, fake test data.** The check scripts create fixtures inside a transaction and roll back. Any data entered by hand in staging is fake.
- **No production credentials in staging**, no service-role key anywhere, and **no production data copied** without the owner's explicit written authorisation.
- Staging never touches the production Vercel project, the demo on `main`, or DNS.

Required variables for a staging build (names only; values come from the staging project):

| Variable | Value for staging |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | staging project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | staging anon key (public by design; protected by RLS) |
| `AUTH_MODE` | `required` (exactly this value) |
| `SUPABASE_SERVICE_ROLE_KEY` | **not set** |
| `ANTHROPIC_API_KEY`, `CONTENT_AGENT_USE_CLAUDE` | not set / `false` (no code reads them today) |

`NEXT_PUBLIC_*` values are fixed at build time: rebuild after changing them.

---

## 3. Applying the migrations to staging (after approval only)

Apply in this order to the **empty** staging project. Both files are forward-only; the foundation file is never edited.

1. `supabase/migrations/20261101000000_foundation.sql`
2. `supabase/migrations/20261104000000_security_hardening.sql`

Either way is acceptable:

```bash
# Supabase CLI, linked to the STAGING project only (check the project ref twice before running)
supabase link --project-ref <STAGING_REF>
supabase db push
```

or paste each file whole into the staging project's SQL Editor and run it once, in the order above. After each file, confirm the result says
"Success" and look at Database > Functions: `submit_content`, `reopen_content` and `decide_approval` must be listed after the second file.

Do not run either file on `ciodkacwdbktuimriuss` as part of M1.

---

## 4. Authentication, the single Owner account, organisation and membership

**One manual test account, role Owner. No manual accounts for admin, approver, staff or viewer.** Other roles, organisation isolation and cross-organisation
attempts are proven by the automated suites and by the SQL fixtures (section 6), which create and discard their own fake users inside a rolled-back transaction.

1. Staging dashboard > Authentication > Users > add the Owner user (email + password chosen by the owner).
2. Staging dashboard > Authentication > Sign In / Providers: turn **off** "Allow new users to sign up" on **staging** (this is the staging project; the existing
   project's setting is the owner's separate decision and is not changed here).
3. In the staging SQL Editor, run once, as an administrator, never from the app:

```sql
insert into public.organizations (name) values ('Cheri & Co. STAGING') returning id;
-- then, with that id and the Owner user's id from the Auth users list:
insert into public.memberships (org_id, user_id, role) values ('<org id>', '<owner user id>', 'owner');
```

The organisation has `is_demo = false` (the default), so the app reads the database, not the sample store.

---

## 5. Hosted verification test plan (18 areas)

Legend. **L** = local simulated test (fake Supabase client, `tests/live-data.test.ts`, `tests/auth.test.ts`): proves application logic only.
**P** = in-process Postgres (PGlite, real SQL of the migrations, `tests/rls.test.ts`, `tests/security-hardening.test.ts`,
`tests/security-hardening-script.test.ts`): proves the SQL, not the hosted service. **H** = hosted staging run: **not yet performed for any row**.

| # | Area | L | P | H: how it is run on staging | H status |
|---|---|---|---|---|---|
| 1 | Authentication and session persistence | yes | — | Sign in as the staging Owner; reload and open a new tab (session persists); wrong password shows the one generic error; sign out; protected URL redirects to `/login` | NOT RUN |
| 2 | Organisation isolation | yes | yes | `docs/rls_live_check.sql` (two organisations in fixtures) and `docs/security_hardening_live_check.sql` | NOT RUN |
| 3 | Owner permissions | yes | yes | Manual as the staging Owner (create/edit/decide/delete paths that exist) plus fixture checks | NOT RUN |
| 4 | Admin permissions | yes | yes | Fixture user `adminA` in both SQL scripts (no manual account) | NOT RUN |
| 5 | Approver permissions | yes | yes | Fixture user `approverA`: may decide, may reopen an approved post | NOT RUN |
| 6 | Staff permissions | yes | yes | Fixture user `staffA`: may write, may not decide, cannot touch locked content | NOT RUN |
| 7 | Viewer permissions | yes | yes | Fixture user `viewerA`: read only | NOT RUN |
| 8 | Customer CRUD | yes | yes | Owner via API: `POST/GET /api/customers`; fixture RLS checks for the other roles | NOT RUN |
| 9 | Retailer CRUD | yes | yes | Owner via API: retailer create creates its first lead | NOT RUN |
| 10 | Lead pipeline operations | yes | yes | Owner moves a deal between stages on `/crm`; reload keeps it | NOT RUN |
| 11 | Product CRUD | yes | yes | Owner creates and edits a product in the Products form; duplicate SKU returns a conflict | NOT RUN |
| 12 | Task operations | yes | yes | Owner creates, completes and postpones a task; the due date moves one day later and is kept | NOT RUN |
| 13 | Approval decisions | yes | yes | Owner submits a post, approves it on `/approvals`; the post becomes approved; a post with a price in it is refused at submit and at approval | NOT RUN |
| 14 | Audit logging | yes | yes | After the decision above: one `audit_log` row with the Owner as actor; `agent_activity` shows the submit/reopen entries | NOT RUN |
| 15 | Orders API | yes | yes | Owner `POST /api/orders` then `PATCH` status; cross-organisation customer link refused | NOT RUN |
| 16 | Sales reporting | yes | — | With two delivered orders in the last 12 weeks, `/reports` Sales shows the right total; cancelled and returned are excluded; paging over 1,000 rows is checked in section 7 | NOT RUN |
| 17 | Unauthenticated API access | yes | yes | `curl` each `/api/*` route without cookies on the staging URL: 401; the SQL scripts check `anon` is denied | NOT RUN |
| 18 | Cross-organisation access attempts | yes | yes | Both SQL scripts (organisation B fixtures); manual: request a record id from another organisation: 404/403 | NOT RUN |

Report the three kinds separately. A passing local test is never recorded as a hosted result.

### The two SQL verification scripts (run on staging only)

| Script | What it proves on the hosted service |
|---|---|
| `docs/rls_live_check.sql` | RLS on every table, tenant isolation, roles, approvals, audit append-only (existing script; re-run because Slices 2 to 4 were built after its only recorded run) |
| `docs/security_hardening_live_check.sql` | The claims guard inside `decide_approval()` (including look-alike spellings, titles and topics), locked content, `submit_content`/`reopen_content`, stranded approvals, the refusal to edit a post's approval, reserved activity history, the length limit, role and isolation checks on the new functions (73 checks) |

How to run each: paste the whole file into the **staging** SQL Editor and click Run once. Each ends with ROLLBACK, leaves nothing behind, and shows a table whose first
row says `ALL n CHECKS PASSED` or `k OF n CHECKS FAILED`. Keep a screenshot or the exported result with the date. If the editor shows only "Success. No rows returned", it displayed the
ROLLBACK instead of the report: nothing is wrong, but the run is not evidence until the report is seen.

---

## 6. Manual hosted run order (single Owner account)

1. Create the staging project, apply both migrations (section 3), create the Owner and organisation (section 4).
2. Run `docs/rls_live_check.sql`, then `docs/security_hardening_live_check.sql`. Both must be all PASS.
3. Start the app against staging: set the staging variables in `.env.staging.local`, run `npm run build` and `npm start` (or deploy to the staging Vercel project later, M7).
4. Walk the rows in section 5 that say "Owner", noting each result.
5. Supabase dashboard: Advisors > Security: no "RLS disabled" and no unexpected "exposed function". Settings > API: exposed schemas are `public` only.
6. Record the outcome in this file or the report (date, who ran it, pass/fail per row).

## 7. Checks that only a hosted run can answer

- **Paging.** The app reads lists in pages of 1,000 by `range`. Whether this staging project's API max-rows is 1,000 (the documented default) is **UNVERIFIED**. Insert
  2,500 fake customers in a transaction-free staging session and confirm `/api/customers` returns all of them, then delete them.
- **Concurrency.** The in-process database has one connection, so true races were not exercised. On staging, from two sessions, submit the same draft at once (one must
  succeed, the other must say "only drafts can be submitted"), and decide the same approval at once (one succeeds, the other says "already decided"). Row locks (`for update`) in
  `submit_content`, `reopen_content` and `decide_approval` are what make this safe; confirm it.
- **Policies the dashboard may differ on:** sign-ups off, password rules, rate limits.
- **`x-forwarded-host` CSRF check** behind the real staging domain.

---

## 8. Rollback and recovery

Staging is disposable: the simplest rollback is to delete the staging project and recreate it. To undo only the hardening on a staging project, use the rollback SQL in
`docs/SECURITY_HARDENING_REPORT.md` (section "Rollback"); it restores the foundation `decide_approval()` and removes the new triggers and functions without touching data.
The application must be rolled back at the same time (it calls `submit_content` and `reopen_content`), by deploying the previous commit.

Never run a rollback on `ciodkacwdbktuimriuss` without the owner's approval and a fresh backup.

## 9. Completion rule for M1

M1 is complete only when: a staging project exists; both migrations are applied there; both SQL scripts show all PASS on staging; the Owner walk-through in section 5 is done and recorded;
the hosted-only checks in section 7 are done; and the owner has accepted the result. Until then the status is **PREPARED, not complete**.
