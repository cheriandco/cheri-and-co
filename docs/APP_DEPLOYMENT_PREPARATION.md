# Deployment preparation: authenticated app at https://app.cheri.co.in

Status of this document: **inspection and planning only.** Nothing described as "pending" has been done. No deploy, push, merge,
DNS, Vercel, Supabase or environment-variable change was made while writing it. Facts below come from the repository at
`feature/supabase-foundation` (HEAD `ac29323`), not from the hosted services, which were **not** queried.

Legend: **DONE** (in the code and tested locally) · **PENDING** (an action not yet taken) · **BLOCKED** (cannot proceed without a
decision or an external step) · **UNVERIFIED** (never run against the hosted Supabase project or a real deployment).

---

## 1. Baseline (inspected)

| Item | Finding |
|---|---|
| Repository | `cheriandco/cheri-and-co` (`origin` = https://github.com/cheriandco/cheri-and-co.git). The repo is **public and stays public by decision** (no paid GitHub upgrade): see the secret and customer-data rules in section 8. |
| Local project | `D:\cheri-and-co` |
| Branches | `main` = `84795ec` (production demo, untouched). `origin/main` = `84795ec`. `demo/safe-demo`, `parked/supabase-auth` (old WIP, superseded). Working branch `feature/supabase-foundation`, **local only, not pushed**, 65 files / +3,930 lines ahead of `main`. |
| Commits on the feature branch | `a28d07f` foundation + auth · `28a4708` tasks/approvals/audit · `386707d` slice 2 customers/retailers/leads · `3a7706a` slice 3 products/content · `ac29323` slice 4 orders + sales report |
| Working tree | At the first inspection: clean. After the overnight stabilisation sprint: **uncommitted** fixes to Slice 1 to 4 code, tests and docs (see `docs/OVERNIGHT_STABILISATION_REPORT.md`); HEAD is still `ac29323`. |
| Framework | Next.js **16.4.1** (App Router), React 19.3, TypeScript 6, `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.118. Local Node v24.16.0. No `engines` field, no `vercel.json`, no `.vercel/` link in the repo. |
| Production demo | https://cheri-and-co.vercel.app, built from `main`. Must stay untouched. |
| Supabase | Project `ciodkacwdbktuimriuss`, Stockholm, Free plan / Nano compute (as recorded in `docs/SUPABASE_SETUP.md`; confirm in the dashboard). |
| Local checks | Last run after the stabilisation sprint: **312 tests pass (8 files)** · `tsc --noEmit` clean · `eslint .` clean · `next build` succeeds. These are local, simulated-client results; none ran against hosted Supabase. (Before the sprint: 286 tests.) |

---

## 2. A. Architecture and deployment readiness

**Application.** One Next.js app. Server-rendered pages under `src/app/(app)/`, 17 API route handlers under `src/app/api/`, a
sign-in page at `src/app/login/`, and `src/proxy.ts` (Next 16's middleware equivalent). Security headers are set in
`next.config.ts` (nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, HSTS 2 years). There is **no
Content-Security-Policy**.

**Two modes, one codebase** (`src/lib/auth/mode.ts`):

| | Demo mode (default) | Required mode |
|---|---|---|
| Trigger | `AUTH_MODE` unset or anything except exactly `required` | `AUTH_MODE=required` |
| Sign-in | None; everyone is the sample user "Anika" | Supabase email + password at `/login` |
| Data | Per-visitor in-memory sample store; nothing is stored | Supabase tables, scoped to the user's organisation |
| Who sees sample data | Everyone | Only members of an organisation with `is_demo = true` |

Because anything other than the exact string `required` means demo, **the existing demo project keeps working with no
configuration even if it runs this newer code.**

**Request path in required mode.** (1) `src/proxy.ts` refreshes the Supabase session cookie and redirects signed-out page requests to
`/login` or answers signed-out API calls with 401. (2) `src/app/(app)/layout.tsx` re-checks on the server and shows "No workspace available
yet" to a signed-in user with no membership. (3) Every API handler starts with `deny(permission, req)` (`src/lib/auth/access.ts`):
role check, plus a same-origin and JSON check on writes. A test enforces that every handler does this. (4) The data layer
(`src/services/`) calls `requireAccess` again and queries Supabase **with the signed-in user's own session**, so Row Level Security applies.
`getAuthUser()` (`src/lib/auth/session.ts`) verifies the session with Supabase Auth on every request, then reads the role and
organisation from the `memberships` table. The service-role key is read by one file (`src/lib/supabase/admin.ts`) that nothing imports.

**Separation of app.cheri.co.in from the demo.** Decided design (section 8, decisions C; not yet carried out):
a **second Vercel project** connected to the same repository, with its own domain and its own environment variables. The demo project keeps
`cheri-and-co.vercel.app` and has no `AUTH_MODE`, so it stays in demo mode. The two projects share no cookies (different hosts), no
environment variables and no deployments.

The branch choice is decided: **Option 1, a dedicated release branch**. Option 2 is kept below only to record why it was not chosen.

| Option | How | Trade-off |
|---|---|---|
| **1. Dedicated release branch (CHOSEN)** | Create e.g. `app-release` from the feature branch; the new project's Production Branch = `app-release`. `main` is not touched, so the demo does not redeploy. | Two long-lived branches to keep in step until the client approves merging. |
| 2. Merge to `main` (NOT chosen) | Both projects build from `main`. | One branch, but merging redeploys the demo project with the new code (behaviour is unchanged while `AUTH_MODE` is unset, and the tests cover that, but it is no longer "untouched"). |

---

## 3. B. Domain and hosting (all PENDING; do not perform until approved)

**Vercel (new project, e.g. `cheri-and-co-app`):**
1. Import `cheriandco/cheri-and-co`; set Production Branch per section 2; framework preset Next.js (auto-detected); build `npm run build`; install `npm ci`.
2. Add the environment variables in section 4 (Production scope only at first).
3. Settings > Functions > **Function Region**: choose a region close to Stockholm (Stockholm `arn1` or Frankfurt `fra1`). The Vercel default
   is Washington D.C.; every request makes at least two round trips to Supabase (session check + membership lookup), so a transatlantic
   gap would be noticeable. There is no `vercel.json` to carry this, so set it in the dashboard or add the file in a later, approved change.
4. Settings > Domains > add `app.cheri.co.in`.
5. Plan: the repo's own note says the current Vercel account is on the **Hobby** plan, which Vercel restricts to non-commercial use. A client's
   business application runs on a paid commercial plan. **Decided as the intended choice; nothing has been purchased** (section 8).

**DNS (eventually, at whoever hosts `cheri.co.in`, not yet identified):**
- One record for the subdomain: `app` **CNAME** to the target Vercel shows when the domain is added (historically `cname.vercel-dns.com`;
  use the value Vercel displays, it can be project-specific). No change to the apex `cheri.co.in` or `www` is needed.
- Check there is no existing `app` A/AAAA/CNAME record, and that any CAA record on `cheri.co.in` permits Let's Encrypt (`letsencrypt.org`).
- Lower the TTL before the change so a mistake can be undone quickly.

**SSL / HTTPS.** Vercel issues and renews the certificate automatically once the CNAME resolves. The app already sends HSTS
(`max-age=63072000; includeSubDomains`) from `next.config.ts`. Note `includeSubDomains` applies to `app.cheri.co.in` only (HSTS is
per host), so it does not affect other `cheri.co.in` sites.

**Preview vs production.**
- Pushing the feature branch to GitHub **will** make Vercel build a Preview deployment in any project connected to the repo, including the
  existing demo project. A preview of the demo project without `AUTH_MODE` is just another demo (harmless); previews in the new project follow
  that project's *Preview* environment variables.
- There will be **two** Supabase projects (decided, not yet created): **staging** and **production**. Preview deployments and Stage 1 to 7
  testing use the staging project's two public values. Only the Production environment of the new Vercel project carries the production
  project's values. Today only one project exists (`ciodkacwdbktuimriuss`); which of the two it becomes is an owner decision, see section 8.
- Cookies are host-only, so a preview URL and `app.cheri.co.in` do not share sessions.

---

## 4. C. Environment variables

The code reads exactly these (`grep process.env src`): `AUTH_MODE`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (one unused file), `NODE_ENV` (set by Next.js), and `CONTENT_AGENT_USE_CLAUDE` (read by
`src/lib/content-agent/config.ts`). Values are never recorded here.

| Variable | Purpose | Public or server-only | Needed in | Configure in |
|---|---|---|---|---|
| `AUTH_MODE` | Must be exactly `required` to turn on sign-in and live data | Server-only (read at runtime on the server and in the proxy) | **Production of the new project.** Leave **unset** in the demo project. Preview: only for a deliberate test. | Vercel > new project > Settings > Environment Variables |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (`https://ciodkacwdbktuimriuss.supabase.co`) | **Public** (inlined into the browser bundle at build time) | New project: Production = production Supabase project; Preview = **staging** Supabase project (the value differs per environment; `ciodkacwdbktuimriuss` is the one existing project) | Same |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The project's *publishable* (anon) key. The name is historical; the value is the `sb_publishable_...` key. Safe in the browser only because RLS protects the data. | **Public** (inlined at build time) | Same as above | Same |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Read only by `src/lib/supabase/admin.ts`, which nothing imports. | **Server-only, secret** | **Do not set anywhere.** Not needed. | n/a |
| `ANTHROPIC_API_KEY` | Reserved for planned Claude drafting; no code reads it | Server-only, secret | **Do not set.** | n/a |
| `CONTENT_AGENT_USE_CLAUDE` | Reserved flag; only changes a note | Server-only | Leave unset (defaults to template drafting) | n/a |

Notes that matter:
- `NEXT_PUBLIC_*` values are baked in at **build** time. Changing them requires a redeploy; adding them after a build does nothing.
- If the Supabase variables are missing while `AUTH_MODE=required`, the app **fails closed** (everything redirects to `/login`; sign-in says
  setup is unfinished). Good, but it means a wrong deploy shows a broken login, not demo data.
- `.env.local` is git-ignored (`.env*.local`), and `.env.example` holds names only. The local `.env.local` also contains an unrelated
  `OPENAI_API_KEY` that no code reads; do not copy it to Vercel.
- Never put the demo project's variables in the new project or the reverse.

---

## 5. D. Supabase readiness

| Area | State | Where / how |
|---|---|---|
| Schema and RLS migration | **DONE (reported)**: `supabase/migrations/20261101000000_foundation.sql` (13 tables, RLS on all, helper functions in the unexposed `private` schema, `decide_approval()`, append-only triggers) was applied by the project owner through the SQL Editor. The file has not changed since its first commit `a28d07f`, so the file equals what was applied. It was applied by pasting, not by the Supabase CLI, so the CLI's migration history table has no record of it. | Not re-verified in this inspection. |
| Live security check | **DONE (reported)**: `docs/rls_live_check.sql` ran in the SQL Editor, 95/95 PASS, rolled back. It covered the foundation tables before Slices 2 to 4. No schema change was made after it. | Re-run before launch (section 7). |
| Email + password auth | **DONE in code**: `signInWithPassword` in `src/app/login/actions.ts`. One generic error for every failure. No sign-up action exists; accounts are created in the dashboard. | |
| Sign-ups | **PENDING / important**: last seen **ON** (`disable_signup: false`). With the public anon key anyone can create an auth user through the API. A stranger would have no membership and could do nothing in the app, but it is unwanted. Turn **off** "Allow new users to sign up". | Dashboard > Authentication > Sign In / Providers |
| Site URL and redirect URLs | **PENDING**. The app uses password sign-in only, with no OAuth, magic link, invite or password-reset page (there is no `/auth/callback` route). These URLs therefore only matter for emails Supabase sends. Set **Site URL = `https://app.cheri.co.in`** and add **only** `https://app.cheri.co.in/**` to Redirect URLs. Do not add `*.vercel.app` wildcards. | Dashboard > Authentication > URL Configuration |
| Existing user and organisation | Reported by the project owner: organisation "Cheri & Co." (`is_demo = false`) and one user with an `owner` membership. **UNVERIFIED** here (hosted project not queried). Real sign-in has **never** been tested. | |
| Membership requirement | **DONE**: a user without a `memberships` row signs in but sees "No workspace available yet" and every API call returns 403. Nobody can write `memberships` through the API. | `src/app/(app)/layout.tsx`, migration |
| Roles | `owner, admin, approver, staff, viewer`. Read: all. Write (tasks, pipeline, products, orders, content): owner/admin/approver/staff. Decide approvals: owner/admin/approver. Delete: owner/admin (no delete screens exist). The app matrix (`src/lib/auth/roles.ts`) matches the database policies. The matrix is marked in code as a proposal pending client confirmation. | |
| Data API exposure | **PENDING check**: confirm "Exposed schemas" is `public` only (so `private` stays hidden), and that Security Advisor lists no "RLS disabled" or "exposed function" warnings. | Dashboard > Settings > API; Advisors |
| Password and abuse settings | **PENDING check**: minimum password length/strength, email rate limits, CAPTCHA/bot protection if offered on the plan. No MFA and no password-reset page exist in the app (not required by the approved scope; resets are done by an admin in the dashboard). | Authentication settings |
| Plan, backups, pausing | The Free plan pauses a project after a week of inactivity and has no managed backups to rely on. A paused production login is an outage. Intended: **paid production project** plus a separate staging project (section 8). Not purchased or changed. | |
| Billing | Not touched. | |

---

## 6. E. Application readiness

| Area | State | Evidence |
|---|---|---|
| Login and session | **DONE locally**. Cookie session via `@supabase/ssr`; `?next=` is restricted to same-site paths (open-redirect safe); sign-out ends the session on every device. | `tests/auth.test.ts` (fake Supabase) |
| Protected routes and APIs | **DONE locally**. Proxy plus layout plus `deny()` plus `requireAccess`. Only `/login` is public. Test fails the build if an API handler lacks `deny(`. | `tests/auth.test.ts` |
| CSRF | Same-origin + `application/json` required on writes in required mode. Uses `x-forwarded-host`, which Vercel sets to the public host. **UNVERIFIED** behind the real domain. | `src/lib/auth/access.ts` |
| Roles | **DONE locally**: viewer gets 403 on every write route; tested per resource. | `tests/live-data.test.ts` |
| Organisation isolation | **DONE locally** two ways: every app query filters on the session's organisation (fake-client tests), and the database policies were run in an in-process Postgres on the real migration (`tests/rls.test.ts`). The hosted project passed the foundation check only. | |
| Demo/live separation | **DONE locally**: a live organisation never receives sample data (tests assert empty/real results for every connected area and "Not connected" for the rest); demo organisations and the public demo keep the sample store. | `tests/live-data.test.ts` |
| Error handling | Pages: `src/app/(app)/error.tsx` and `not-found.tsx` exist. New write routes map a database refusal to 403 and a clash to 409. Since the stabilisation sprint (uncommitted) the older write routes (tasks, pipeline, approvals) map a refusal to 403 as well; agent actions and discovery are refused for real organisations before any database call. There is no root-level `global-error.tsx` (not a security hole). | See section 7 |
| Build and tests | **DONE locally**: 312 tests pass, typecheck, lint and production build clean (simulated clients only). | local run |

**What is connected to the database for a live organisation** (from `docs/SUPABASE_SETUP.md` and the code): tasks, approvals (decisions
through `decide_approval()`), audit log, agent activity, customers, retailers and leads (B2B pipeline), products, the social content
calendar (create, edit, submit for approval), orders (**API only, no screen, by decision**) and a Sales report (delivered orders only).

**What a live organisation sees as not connected** (no table or data source exists for it; this is shown as unavailable, never as sample data):
- **B2C Sales Agent page** (`/b2c`) and **Amazon Intelligence page** (`/amazon`): both render "Not connected yet" (conversations and Amazon
  seller data have no table).
- Reports: only Sales; the other six sections are sample-only.
- Content: pack generator, brand rules, assets, performance and published tabs say "Not available yet".
- Dashboard: approvals, tasks, orchestrator counts, pipeline funnel and top retailers only; KPI cards, trends and agent tiles are empty.
- CRM: the conversations tab is empty; "Sales reports" tile is hidden.
- The stale Settings text and the stale opening of `docs/SUPABASE_SETUP.md` were corrected in the stabilisation sprint (uncommitted).

**Never verified against the hosted Supabase project (UNVERIFIED):**
1. A real sign-in with the real user, and the resulting membership lookup.
2. Every Slice 1 to 4 query as PostgREST sees it. All were tested with a recording fake client, so the exact filter syntax is untested live,
   for example `.not("status","in","(cancelled,returned)")`, `.in("platform",[...])`, `.gte("ordered_at",...)`, `select("... organizations(is_demo)")` and
   the embedded join in `getAuthUser`.
3. The approval round trip: queueing an approval as a writer, `decide_approval()` as an approver, and the mirror update of
   `content_items.status` afterwards.
4. Composite foreign-key refusals and the duplicate-SKU (`23505`) and foreign-key (`23503`) error codes as PostgREST returns them.
5. Anything behind `app.cheri.co.in` (CSRF origin check, cookies, HSTS, Vercel region latency).
6. Slices 2 to 4 under the hosted RLS. The 95-check script predates them (no schema change since, so the policies are the same).

---

## 7. F. Staged deployment testing checklist

Test data rules (decision B): there is **one** staging test account (one email and password, role Owner) in the **staging** Supabase project
only. No test user, organisation or row is ever created in production. Rows made while testing start with `DEPLOYTEST` and are deleted
afterwards. Other roles and cross-organisation isolation are proven by the automated suites (`tests/live-data.test.ts`, `tests/rls.test.ts`,
the SQL check), by role switches inside controlled test fixtures, and by SQL checks run as the owner, **not** by extra login accounts.

**Stage 0: Before anything is deployed**
- [ ] Decisions in section 8 carried out for staging. Sign-ups turned off on staging and production. Site URL and redirect URL set. Exposed schemas = `public` only.
- [ ] Re-run `docs/rls_live_check.sql` in the SQL Editor (single run, ends in ROLLBACK): expect all PASS. Run Security Advisor.
- [ ] `npm ci && npm run typecheck && npm run lint && npm test && npm run build` on the exact commit to be deployed.

**Stage 1: Preview deployment**
- [ ] Prerequisite: the repository stays public, so first run the secret and customer-data scan in section 8 on the release branch. Push the release branch (approval needed). Confirm Vercel builds a Preview in the **new** project only and that the demo project's Production deployment is unchanged (same commit `84795ec`).
- [ ] Preview variables: set `AUTH_MODE=required` plus the two **staging** Supabase variables (never the production project's, decisions B and D). Deployment Protection on, so the URL is not public.
- [ ] Open the preview signed out: every page redirects to `/login`; `curl` any `/api/...` returns 401.

**Stage 2: Domain configuration**
- [ ] Add `app.cheri.co.in` in the new project; create the CNAME; wait for "Valid Configuration" and a certificate.
- [ ] `https://app.cheri.co.in` loads over HTTPS, HTTP redirects to HTTPS, HSTS header present, no mixed content.
- [ ] `https://cheri-and-co.vercel.app` still shows the demo with no sign-in and sample data (compare with a screenshot taken beforehand).

**Stage 3: Authentication**
- [ ] Wrong password: generic "Incorrect email or password." Right password: lands on `/dashboard`. `?next=` honours same-site paths only (`?next=//evil.example` goes to `/dashboard`).
- [ ] Refresh and close/reopen the tab: session persists. Sign out: `/dashboard` redirects to `/login`; the old cookie no longer works.
- [ ] "No workspace available yet" and API 403 for a user without a membership: covered by `tests/auth.test.ts` and the SQL check; not tested with a second login (one staging account only).
- [ ] Sign-up through the public Auth API is refused.

**Stage 4: Organisation isolation**
- [ ] Re-run the SQL check for isolation (it builds its own throwaway organisations and users inside a transaction that is rolled back). In the app, confirm the single staging account sees only its own organisation's rows. Cross-organisation reads, edits and links are proven by that SQL check and `tests/rls.test.ts`, not by a second login.
- [ ] A live organisation shows no sample names anywhere (search for a sample retailer name such as "Aurelia", and a sample customer, in the search box and each page).

**Stage 5: CRUD**
- [ ] Customers: create (`POST /api/customers`), appears in list, detail and search. Retailers: create adds a lead at stage "new"; drag/move stage in CRM pipeline persists after refresh.
- [ ] Products: add, edit, duplicate SKU gives a clear error, blank price/stock stay "—".
- [ ] Content: create a draft, edit it, submit it.
- [ ] Orders (API only): create, status update, list; Reports > Sales shows only delivered orders; customer Purchases excludes cancelled and returned.
- [ ] Viewer, staff, approver and admin behaviour: proven by automated tests and SQL role switches (decision B), not by separate accounts. The staging Owner account can only exercise Owner paths.

**Stage 6: Approval workflow**
- [ ] Submit a content draft: a pending approval appears in Approvals and the post shows "Pending approval".
- [ ] A post containing a price/discount/stock claim is blocked at submit (422) and again at approve.
- [ ] As the staging Owner: approve and reject; audit log gains a row with the real signed-in user; the post's status follows the decision and `content_items.status` is updated.
- [ ] "Staff cannot decide" is covered by tests and SQL, not a live login. A second decision on the same approval is refused. Nothing is published anywhere.

**Stage 7: Agent and dashboard verification** (the five approved agents and the Orchestrator)
- [ ] Dashboard: pending approvals, tasks, orchestrator counts, funnel, top retailers match the database.
- [ ] B2B Lead and CRM & Sales Ops pages work on live data. Content & Marketing works for posts and approvals.
- [ ] B2C Sales and Amazon Intelligence: launch blockers (section 10). "Not connected yet" is acceptable on staging only; for production it needs delivery or written client acceptance.
- [ ] Orchestrator brief shows real counts for CRM, B2B and Content and "Not connected" for the two others.

**Stage 8: Production readiness**
- [ ] Production variables set only in the new project; `SUPABASE_SERVICE_ROLE_KEY` not set anywhere; Preview `AUTH_MODE` removed again unless needed.
- [ ] Function region set near Stockholm; page loads feel responsive.
- [ ] Production Supabase on a paid plan (owner action, not done by this document) with backups confirmed; a manual export taken before go-live.
- [ ] Monitoring: Vercel runtime logs and Supabase Auth/API logs checked after the first sign-in for errors.
- [ ] Go/no-go checklist (section 9) all ticked.

**Stage 9: Rollback procedure**
1. **App:** in the new project, Deployments > promote the previous good deployment (instant rollback), or revert the commit on the release branch and redeploy. The demo project is independent and unaffected.
2. **Fast "switch off":** set `AUTH_MODE` to anything other than `required` and redeploy. The app returns to the public sample demo, which hides the live data. Use only if exposing the sample is acceptable for that host.
3. **Domain:** remove the CNAME (or the domain from the Vercel project). The demo domain is not involved.
4. **Database:** the migration is forward-only (there is no down script) and nothing in the app writes schema. Rolling back app code needs no database change. Data fixes are done by an owner in the SQL Editor. Restore only from a backup/export taken in Stage 8.
5. **Keys:** if the publishable key is ever exposed in a harmful way, rotate the API keys in Supabase and update the two `NEXT_PUBLIC_*` values, then redeploy (public keys are baked into the build).

---

## 8. G. Risks, blockers and decisions

**Critical blockers (do not launch until resolved)**
1. **Real sign-in and every live query have never run against the hosted project** (section 6, list of UNVERIFIED). Stage 3 to 6 must pass first.
2. **Public sign-ups are ON** (last seen). Must be switched off before the app is reachable.
3. **B2C Sales and Amazon Intelligence are launch blockers (decision F).** On `app.cheri.co.in` both pages are "Not connected yet" because
   they have no data source (no conversation or Amazon table exists). Launch waits until the promised functionality is delivered or the
   client's acceptance of the current state is documented. Findings are in section 10. No new tables, agents or features are proposed here.
4. **Repository is public by decision (A).** Mitigation is process: secret and customer-data scan before the first push, no secrets or client data ever committed.
5. **Hobby plan and Free Supabase (decisions C and D)** must be replaced by paid plans, and a staging Supabase project created, before launch (owner actions).

**Important outstanding tasks**
- Create the new Vercel project from the release branch on a paid plan; create staging and production Supabase projects; identify who controls `cheri.co.in` DNS. All are owner actions, none done.
- Confirm "Exposed schemas", Auth settings, Site URL and redirect URL (section 5) on both Supabase projects.
- Re-run `docs/rls_live_check.sql`; run Security Advisor.
- Small fixes: done in the stabilisation sprint, uncommitted and awaiting review (403 mapping, task assignee/postpone, complete lists, approval-backed post status, stale text).
  Still open: decide whether `paid` orders count as revenue (currently delivered only, as instructed).
- Confirm the role matrix with the client (marked as an assumption in `src/lib/auth/roles.ts`).

**Optional improvements (not required by the promised scope)**
- Content-Security-Policy header. · A `vercel.json` to pin region and Node version, plus an `engines` field. · Password-reset and invite
  pages (today an administrator sets passwords in the dashboard). · MFA. · A root `global-error.tsx`. · Error tracking. · Supabase CLI migration
  history for future changes. · (Repository visibility is decided: it stays public.)

**Recorded deployment decisions (owner, final).** Each is a *decision*, not an action: none has been carried out and nothing has been purchased.

**A. GitHub.** The repository `cheriandco/cheri-and-co` **stays PUBLIC**. No paid GitHub upgrade. It must not be made private. Because it is public:
- never commit secrets, `.env*` files (except `.env.example` with blank names), keys, tokens, passwords or the Supabase service-role key;
- never commit customer data, real catalogues exports, order exports, screenshots of live data or database dumps;
- run a secret and customer-data scan of the release branch **before** its first push (it publishes every commit in that branch's history);
- the only Supabase values that may appear in the browser bundle are the project URL and the publishable key; the service-role key is never set anywhere;
- the SQL migration and `docs/rls_live_check.sql` contain no data and are acceptable to publish; real client data lives only in Supabase.

**B. Test account.** Exactly **one** staging test account: one email address and password, role **Owner**, in the **staging** project only.
No Admin, Approver, Staff or Viewer login accounts. Other roles and cross-organisation isolation are tested through the automated suites
and controlled fixtures. **No test user is ever created in production.**

**C. Hosting.** Dedicated release branch; **separate Vercel project** for `app.cheri.co.in`; the existing demo project, `main` (`84795ec`)
and `cheri-and-co.vercel.app` are preserved untouched. The paid commercial Vercel plan is the intended choice; nothing has been purchased.

**D. Supabase.** A separate **staging** project and a **production** project. Paid production Supabase is the intended choice. No project
has been created and no billing or setting has been changed. The existing project `ciodkacwdbktuimriuss` (Free plan) is the only one today.

**E. DNS.** Prepare the requirement only: one `app` CNAME to the target Vercel displays when the domain is added to the new project (section 3). No DNS change.

**F. B2C Sales and Amazon Intelligence** are launch blockers until the promised functionality is delivered or the client's acceptance of the
current state is documented in writing (section 10 and `docs/FINAL_DELIVERY_ROADMAP.md`).

**Effect on the plan.** Stages 1 to 7 of section 7 run against the **staging** Supabase project and a Preview of the new Vercel project, with one Owner account.
Production is touched only at Stage 8 onwards.

**Still open (owner inputs, not decided):** who manages `cheri.co.in` DNS; the exact paid Supabase tier and region (suggest Stockholm for both, to match); whether the
existing project becomes staging or production; the Vercel team/seat for the paid plan.

---

## 9. Final go / no-go checklist

**Go only if every box is ticked.**
- [ ] The recorded decisions in section 8 are carried out: secret scan of the public repo done; paid Vercel plan on the new project; paid production Supabase and a separate staging project exist; the demo project and `main` are untouched.
- [ ] All testing used staging only, with the single Owner test account; no test users, organisations or rows exist in production.
- [ ] Supabase sign-ups are off; Site URL and redirect URL set; Exposed schemas = `public`; Security Advisor clean.
- [ ] `docs/rls_live_check.sql` re-run: all checks PASS (no FAIL).
- [ ] Local gate on the release commit: tests, typecheck, lint, build all green.
- [ ] Stage 1 to 7 of the checklist passed on a preview and on `app.cheri.co.in`, including a **real** sign-in, isolation, CRUD and the approval round trip.
- [ ] Demo at `cheri-and-co.vercel.app` verified unchanged after the new project went live.
- [ ] Production variables correct: `AUTH_MODE=required`, the two `NEXT_PUBLIC_SUPABASE_*` values; **no** service-role or Anthropic key set.
- [ ] Backup/export taken; rollback steps (Stage 9) read and understood by the person on call.
- [ ] B2C Sales and Amazon Intelligence: promised functionality delivered, **or** the client's written acceptance of the current state is on file (launch blocker, section 10).
- [ ] Nothing outside the five approved agents, the Orchestrator, the central CRM/database, the dashboard and human approval was added.

**No-go if any of:** sign-ups still on · any isolation or role test fails · a sample name appears for the live organisation · the demo
changed · a secret appears in the browser bundle, repository or logs · the SQL check shows a FAIL.

---

## 10. Launch blockers: B2C Sales and Amazon Intelligence (inspection, no changes made)

**Provenance caveat.** No signed proposal or scope document exists in the repository or on this machine (searched `D:\` to depth 3 for
"proposal"). The "original promise" below is reconstructed from: `docs/UX_FLOWS.md` section 3 (items 2 and 3, "requested in original
brief", inherited, not client-confirmed), `docs/BUSINESS_CONTEXT.md`, `docs/DATABASE.md` section 2, `docs/API.md` section on the original
brief, `docs/PHASE1_UI_FREEZE.md`, `README.md`, and the project memory ("agents per agreed proposal"). Client confirmation of agent scope is
**not recorded**. Treat the list as the best available reading, to be confirmed with the owner.

### 10.1 What was promised
**B2C Sales Agent.** Instagram as the customer enquiry channel; answer enquiries; qualify; recommend products; hand over to a human when it
matters (order status, refunds, complaints, unclear or no-match enquiries); every reply drafted for human approval before it reaches a
customer; conversation history per customer (original brief: conversations and messages entities, `GET/POST /api/conversations`,
Instagram inbound webhook).
**Amazon Intelligence Agent.** Amazon and Flipkart click/purchase tracking and an Amazon intelligence workflow: demand, competition,
pricing signals, review themes, listing quality, turned into recommendations that wait for human approval (original brief entities:
amazon_products, amazon_competitors, amazon_reviews, amazon_insights).

### 10.2 What is implemented today
| | Demo / sample mode | Live organisation (`AUTH_MODE=required`) |
|---|---|---|
| B2C | `/b2c`: rule-based intent, sample catalogue (18 invented `SAMPLE-` products), draft reply, escalation reasons, recommendations, sample conversation list, "send reply to approval (demo)". 35 tests. Nothing sent or stored. | Page shows "Not connected yet". `POST /api/agents/b2c/run` returns **501**. `getConversations()` returns empty. |
| Amazon | `/amazon`: 8 tabs (overview, products, competitors, reviews, pricing, opportunities, listings, recommendations) over invented rows; rule-based recommendations; "send to approval (demo)". | Page shows "Not connected yet". `getAmazon()` returns empty. Orchestrator/dashboard use no Amazon data. |

What *is* live and relevant: `orders.channel` accepts `instagram`, `amazon`, `flipkart`; `customers.instagram` exists; `approvals.generated_by`
and `agent_activity.agent` accept `b2c` and `amazon`; the live Approvals flow, audit log and claim guard work for any submitted text.

### 10.3 What is missing
- **No data source for either agent**: no `conversations`/`messages` table, no Amazon tables. No real catalogue (live `products` has price/stock but the B2C search reads only the sample catalogue).
- **No inbound channel**: no Instagram (or WhatsApp/email) webhook or API connection; no Amazon/Flipkart connection or click tracking.
- **No live agent run**: B2C route is deliberately disabled for live organisations; no live Amazon insight generator.
- Client inputs not supplied: catalogue, policies (returns, shipping, discounts), approved claims, escalation owner, marketplace links, Meta/Amazon/Flipkart account access.
- Persisted agent reasoning/recommendations (no `recommendations`/`agent_runs` entities).

### 10.4 Can existing code deliver the promise without new schema or scope expansion?
- **Schema: no, not fully.** Stored conversations and stored Amazon data need tables that do not exist. This was a deliberate non-goal of the foundation; adding tables is a schema change needing separate approval.
- **Code reuse: yes, substantially (see `docs/FINAL_DELIVERY_ROADMAP.md` for the line-by-line mapping).** The B2C engine (`src/lib/b2c-agent`), Amazon logic (`pricePosition`, `amazonActionFor`, `buildSuggestions`), approvals, claim guard, audit and role checks are reusable as they are.
- **Without any schema change, a narrower slice is possible:** B2C = a *stateless* draft assistant for a live organisation (staff paste an enquiry, the engine drafts a reply, escalation applied; recommendations need an adapter from live `products`, which lack style/occasion/material fields, human submits to Approvals). Nothing persisted except the approval. Amazon = limited to what `orders` (channel amazon/flipkart) and live `products` can show (sales by channel, our prices), with no competitor, review or listing data.
- That narrower slice does **not** equal the original promise (stored Instagram conversations; competitor/review/pricing intelligence). Those need either schema + an integration, or data entered manually into new tables, or client acceptance of a reduced scope.

### 10.5 Minimum work to fulfil the original promise (estimate of steps, not a plan to start)
1. **Confirm scope in writing** with the client: which B2C channel (Instagram only?) and what Amazon data is expected (manual entry, CSV, or API). This is the gating decision.
2. **Schema (needs approval):** `conversations` and `messages` (org-scoped, RLS as existing tables); for Amazon at minimum competitor/review/pricing/listing tables or one generic insights table; RLS tests added to the PGlite suite; applied to **staging** first (all of this is unapproved; no table, migration or API is created by this assignment).
3. **B2C live path:** read conversations from the DB; point the engine at live `products` (the engine searches `CatalogueProduct` records that carry style, occasions and material; the live `products` table has only sku, name, category, price, stock, status and channels, so an adapter and client-supplied attributes are needed); enable the run route for live organisations; send results to the existing Approvals flow; Instagram intake either manual paste/entry (smallest) or an approved Meta integration (largest, needs client account and Meta app review).
4. **Amazon live path:** data entry or import into the new tables; replace `sampleOr` with live reads; keep recommendations rule-based; approvals unchanged. A real Amazon API/Seller connection is a separate, larger item needing client credentials.
5. **Tests and verification** against staging with the single Owner test account plus automated suites; update docs/labels so nothing simulated is presented as live.
- **Smallest honest option:** document client acceptance that, at launch, B2C is a draft-only assistant and Amazon is "not connected", keep the "Not connected yet" pages, and schedule steps 2 to 4 afterwards. This satisfies decision F's second branch only if the acceptance is written and on file.
