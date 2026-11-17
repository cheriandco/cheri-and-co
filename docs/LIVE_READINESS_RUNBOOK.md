# Live readiness runbook (owner actions)

Prepared 2026-11-16. **Nothing in this document has been carried out.** No migration was applied, no setting or user was changed, nothing
was deployed, and the existing public demo (`https://cheri-and-co.vercel.app`) is untouched. Each step says who does it. Supabase project:
`ciodkacwdbktuimriuss`. Related: `docs/SUPABASE_SETUP.md`, `docs/APP_DEPLOYMENT_PREPARATION.md` (sections 3 to 9).

Do the steps in this order. Stop at the first failure and report it.

## Step 1. Hosted RLS verification (you, about 5 minutes)

File: `docs/rls_live_check.sql` (95 checks). It makes fake users and organisations inside one transaction and ends in `ROLLBACK`, so nothing
is kept. It changes no policy, setting or real row, and uses no service-role key.

1. Supabase dashboard, project `ciodkacwdbktuimriuss`, **SQL Editor**, New query.
2. Paste the **whole** file and click **Run once**. Do not run part of it; do not run it twice at the same time.
3. Expected: the top row says `ALL 95 CHECKS PASSED` (the count may differ slightly if the file was edited; what matters is no `FAIL` row).
4. If the editor only says "Success. No rows returned", it showed the `ROLLBACK` instead of the report: nothing is wrong and nothing was kept; tell me.
5. If it stops with an error, run `ROLLBACK;` on its own, then send me the error text.
6. Also open **Advisors > Security Advisor**: there must be no "RLS disabled" or "exposed function" warning.
7. Also open **Project Settings > API > Exposed schemas**: it must list `public` only (so the `private` schema stays hidden).

Send me: the SUMMARY line, and any FAIL rows. (Do not send keys or screenshots that show keys.)

## Step 2. Turn off public sign-ups (you, 2 minutes)

Why: the project currently accepts sign-ups (checked 2026-11-16: `disable_signup: false`). A stranger could create an auth user. They would
see no data (no membership), but it should be off. Turning it off does **not** stop you creating users yourself in the dashboard.

1. Supabase dashboard, project `ciodkacwdbktuimriuss`.
2. Left menu **Authentication**, then **Sign In / Providers** (older dashboards: **Providers**, or **Settings** under Authentication).
3. Under **User Signups**, turn **off** "Allow new users to sign up". Click **Save**.
4. While there: under **Email**, keep the email provider enabled (the app signs in with email and password). Leave other providers off.
5. **Authentication > URL Configuration**: Site URL = `https://app.cheri.co.in` once that domain is decided; add only `https://app.cheri.co.in/**` to
   Redirect URLs. No `*.vercel.app` wildcards. (The app has no email links today, so this matters only for emails Supabase sends.)
6. Check it worked (any machine, no secrets needed):
   ```bash
   curl -s https://ciodkacwdbktuimriuss.supabase.co/auth/v1/settings -H "apikey: <the publishable key>"
   ```
   The JSON must contain `"disable_signup":true`. Or tell me "done" and I will run the same check with the key already in `.env.local`.

## Step 3. Owner account and organisation (you, 10 minutes)

**First check what already exists.** The deployment notes say an organisation "Cheri & Co." and one owner membership were reported to exist, but
this was never verified. In the **SQL Editor** run (read-only):
```sql
select o.id, o.name, o.is_demo, m.role, u.email
from public.organizations o
left join public.memberships m on m.org_id = o.id
left join auth.users u on u.id = m.user_id
order by o.created_at;
```
- If you see one row for "Cheri & Co." with `is_demo = false`, role `owner` and the owner's email: **skip to Step 4.**
- If it returns nothing: continue below.

**Create the owner user (dashboard, not SQL):**
1. **Authentication > Users > Add user > Create new user.**
2. Enter the owner's email and a strong password. Tick **Auto Confirm User**. Choose the password yourself and keep it private
   (do not send it to me or paste it in chat). Do not use "Invite user": the app has no set-password page.
3. A profile row is created automatically by a database trigger.

**Create the organisation and the owner membership (SQL Editor, once):**
```sql
with org as (
  insert into public.organizations (name, is_demo) values ('Cheri & Co.', false) returning id
)
insert into public.memberships (org_id, user_id, role)
select org.id, u.id, 'owner' from org, auth.users u where u.email = '<owner email>'
returning org_id, user_id, role;
```
Expect one returned row. If it returns zero rows the email does not match a user: fix the email, and note the organisation row was still
created (check with the read-only query above before re-running, to avoid a duplicate organisation).

Verify: re-run the read-only query. Exactly one organisation, `is_demo = false`, role `owner`.
Never create an organisation with `is_demo = true` for the real client. Roles available: owner, admin, approver, staff, viewer.

## Step 4. Test-account policy and sign-in test (you)

**A decision is needed first.** The recorded decision B in `docs/APP_DEPLOYMENT_PREPARATION.md` says: one Owner test account, in a
**staging** Supabase project only, and **no test user in production**. But `ciodkacwdbktuimriuss` is currently the only project and is being
treated as production. Choose one:
- **(Recommended) Use a separate staging Supabase project** for the test account. Create it, apply the foundation migration there, and run
  Steps 1 to 4 against it. Production never gets a test user.
- **Or** sign in with the real owner account only (no extra user), and delete any rows you create while testing (they start with `DEPLOYTEST`).
  Do not create a throwaway user in production.

Do not use `CHERI_TEST_PASSWORD` from `.env.local` (decided). The script below asks for the password at the prompt and does not read it from the file.

**Run the automated sign-in check (read-only; you type the password hidden; nothing is stored):**
```bash
node --no-warnings --env-file=.env.local scripts/verify-live-signin.ts
```
(PowerShell, from `D:\cheri-and-co`. Node 24 runs the `.ts` file directly.) It reads only the two public variables
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) from the environment. It prints PASS/FAIL lines with counts only, never row
contents, tokens or the password. Expected: `ALL 18 CHECKS PASSED`. It checks: sign-in works; one membership with a known role;
the organisation is live (not demo); exactly one organisation visible; zero customers of any other organisation; all ten data tables readable;
the `private` schema not reachable; sign-out ends the session. Send me the PASS/FAIL output only. (The hidden password prompt was tested
only with empty input; if the typed password echoes on screen, close the window and tell me.)

**Then the manual app checklist** (local, no deploy): in `.env.local` set `AUTH_MODE=required` (you edit it; do not paste values to me),
run `npm run dev`, and open `http://localhost:3000`.
- [ ] Signed out: `/dashboard` redirects to `/login`.
- [ ] Wrong password shows "Incorrect email or password." (one generic message).
- [ ] Right password lands on `/dashboard`. Refresh and reopen the tab: still signed in.
- [ ] `/login?next=//evil.example` after sign-in goes to `/dashboard` (no open redirect).
- [ ] No sample names anywhere (search for "Aurelia"); pages without data say "Not connected yet" or are empty.
- [ ] Create one task, one customer, one product, one retailer (names start with `DEPLOYTEST`). Each appears after refresh.
- [ ] Submit a content draft: a pending approval appears. Approve it: the audit log shows your email as the actor.
- [ ] Sign out: `/dashboard` redirects to `/login` again.
- [ ] Delete the `DEPLOYTEST` rows afterwards (SQL Editor, as owner).

## Step 5. Separate authenticated Vercel project (prepared only; do not create it yet)

Goal: `app.cheri.co.in` runs the live app; `cheri-and-co.vercel.app` stays the public demo. Both read the same repository. Order matters:

| # | Action | Who |
|---|---|---|
| 1 | Run the secret and customer-data scan on the release branch (the repo is public by decision A). | me, on request |
| 2 | Create a dedicated branch `app-release` from `feature/client-delivery` and push it. **Create it before the project**, or Vercel builds `main` (the demo). | you approve, me |
| 3 | Vercel: **Add New > Project**, import `cheriandco/cheri-and-co`, name `cheri-and-co-app`. Do **not** edit the existing `cheri-and-co` project. | you |
| 4 | Settings below. | you |
| 5 | First build is a Preview or a build that fails closed; check it before adding the domain. | both |

**Settings for the new project `cheri-and-co-app`:**

| Setting | Value |
|---|---|
| Framework | Next.js (auto) |
| Install / Build | `npm ci` / `npm run build` |
| Production Branch | `app-release` |
| Function Region | `arn1` (Stockholm) or `fra1`; the default (Washington D.C.) adds latency to every request |
| Deployment Protection | On for Preview deployments |
| Domain | `app.cheri.co.in` (DNS owner not yet identified; one `app` CNAME to the target Vercel shows) |

**Environment variables (Production scope only at first):**

| Name | Value | Notes |
|---|---|---|
| `AUTH_MODE` | `required` | exactly this string |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://ciodkacwdbktuimriuss.supabase.co` | public; baked in at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `sb_publishable_...` key | public by design; you enter it in Vercel, I never see it |

Do **not** set: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, any `AMAZON_*`, any Google value. Leave Preview and
Development empty (a Preview without `AUTH_MODE` is just another demo; it must never get production database values).

**Hobby plan note:** Vercel Hobby is for non-commercial use. A client business app belongs on a paid plan (decision C: intended, not purchased).
Cost and plan are your decision; I changed nothing.

**What keeps the demo untouched:** the demo project has no `AUTH_MODE`, no Supabase variables and builds from `main` (`84795ec`). Pushing
`app-release` creates a Preview in the demo project too (it is connected to the same repository); that preview has no `AUTH_MODE`, so it is
just another demo and Production of the demo does not change. Do not merge to `main`.

**Rollback:** promote the previous deployment in `cheri-and-co-app`, or remove the domain. The demo project is independent.

## Open decisions for the owner
1. Test account: staging project (recommended) or the real owner account only (Step 4).
2. Paid Vercel plan and paid Supabase production plan (free Supabase projects pause after a week of inactivity, which would be a login outage).
3. Who manages DNS for `cheri.co.in`.
