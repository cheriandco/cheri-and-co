# Supabase foundation: setup and security

Status: **built and tested locally; not applied to the client's Supabase project.** No Supabase credentials for
project `ciodkacwdbktuimriuss` were available, so nothing here has run against the hosted service. The SQL was
executed and tested in an in-process Postgres (`tests/rls.test.ts`); the sign-in code was tested with a fake client.

## What exists
- `supabase/migrations/20261101000000_foundation.sql`: 13 tables, all with Row Level Security, no sample rows.
  Tables: `organizations`, `profiles`, `memberships`, `customers`, `products`, `retailers`, `leads`, `orders`, `tasks`,
  `approvals`, `content_items`, `agent_activity`, `audit_log`.
- `AUTH_MODE=demo` (default): the public demo, unchanged. No sign-in, sample data only, nothing stored.
- `AUTH_MODE=required`: every page and API call needs a verified Supabase session and a row in `memberships`.
- The agents still read the built-in sample data. Moving each agent onto these tables is a separate piece of work.

## Security model
- Tenancy comes from `public.memberships (org_id, user_id, role)`. Policies compare `org_id` with the caller's own
  memberships. The browser never supplies an organisation id that is trusted.
- Nobody can write `memberships` through the API, so nobody can grant themselves access or a higher role.
- Roles: owner, admin, approver, staff, viewer. Read: any member. Write: owner/admin/approver/staff. Delete: owner/admin.
  Decide approvals: owner/admin/approver, and only through `decide_approval()`, which also writes the audit row.
- `anon` (signed-out) has no privileges on any table. `audit_log` and `agent_activity` are append-only (policy + trigger).
- Composite foreign keys `(org_id, id)` stop a row pointing at another organisation's record.
- Demo and real data are separated: the built-in sample data is visible only to members of an organisation with
  `is_demo = true`. Any other organisation sees "No workspace available yet" until its data is connected.
- Server side: `proxy.ts` (optimistic), the layout, `deny()` at the top of every API handler, and `requireAccess()`
  inside the data layer. The service-role key is read only by `src/lib/supabase/admin.ts`, which nothing imports.

## Manual steps (in order)
1. Supabase dashboard, project `ciodkacwdbktuimriuss`, Project Settings > API: copy the **URL** and the
   **anon / publishable** key. Put them in `.env.local` as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   Never paste the `service_role` key anywhere in chat.
2. Authentication > Sign In / Providers: **turn off "Allow new users to sign up"** (the project currently has sign-ups ON).
   Set Site URL to the real site address, and add redirect URLs only for addresses you control.
3. Apply the migration (SQL editor: paste the file and run, or `supabase db push` linked to this project only).
   Check the Security Advisor shows no "RLS disabled" warnings.
4. Invite the first user and create their organisation: follow "Invite the first user" below.
5. Set `AUTH_MODE=required` plus the two public variables locally, run `npm run dev`, sign in, and confirm that a user
   with no membership sees "No workspace available yet".
6. Only then set the same variables in Vercel (not done here; deployment settings were not touched).

## Invite the first user (needs the owner's approval; nothing here has been done)
Live data is shown to members of an organisation with `is_demo = false`. Members of an `is_demo = true` organisation see
the built-in sample data instead. Do these in the dashboard / SQL editor as the project owner:
1. Authentication > Users > **Add user > Create new user**: enter their email and a strong password and tick **Auto Confirm User**.
   Give them the password privately. (Do not use "Invite user" yet: the app has no set-password page, so an invite link
   would have nowhere to land. Sign-ups stay off.)
2. SQL editor, once:
   ```sql
   insert into public.organizations (name, is_demo) values ('Cheri & Co.', false) returning id;
   insert into public.memberships (org_id, user_id, role)
     select '<org id from above>', id, 'owner' from auth.users where email = '<their email>';
   ```
3. In `.env.local` set `AUTH_MODE=required`, run `npm run dev`, sign in at `/login`. You should land on a dashboard that shows
   only Approvals, Tasks and the orchestrator summary; every other page says "Not connected yet".
4. Create a task, then check it with `select title, org_id from public.tasks;`.
Optionally add a second organisation `('Cheri & Co. (sample demo)', true)` and a second membership to see the sample data.

## What is connected to the database
- Slice 1: Tasks, Approvals (decisions go through `decide_approval()`), Audit log, Agent activity, dashboard and orchestrator counts.
- Slice 2: Customers, Retailers and Leads (the B2B pipeline). Read, create (`POST /api/customers`, `POST /api/retailers`, which also
  creates the retailer's first lead at stage `new`) and move a deal between stages. No delete UI exists, so none is wired.
  Gaps: no Amazon/Flipkart click columns (shown as 0 and hidden for live orgs); `purchases` = count of the customer's orders;
  retailer score/temperature/stage live on `leads`; the Maps link is a derived search link; Qualification factors, follow-up
  recommendations and discovery candidates are sample-only and hidden for live orgs.
- Slice 3: Products (list, detail, create, edit; `products:write` = owner/admin/approver/staff) and Content (`content_items`: social
  posts on Instagram, Facebook and LinkedIn; create, edit a draft or rejected post, submit for approval). A post's status follows its
  approval (queued as a pending `approvals` row, decided through `decide_approval()`); `content_items.status` is mirrored after a decision.
  Gaps: no engagement/metrics columns (Performance is "not available"); no asset storage; no brand-rule table; "Simulate publish" is
  demo-only (the app never posts); the Content pack generator uses the sample catalogue so it is hidden for live orgs; posts on
  Pinterest, Email and Amazon A+ are allowed by the table but have no screen; no delete UI; a product price or stock left blank stays null.
- Not connected yet: orders and the agents' own inputs (B2C conversations, Amazon data, B2B discovery).
  For a live organisation these show "Not connected yet" or empty, never sample data.

## Known limitations
- Agent data is still sample data in server memory; this work does not store business data yet.
- The prohibited-claims guard for content runs in the application, not inside `decide_approval()`.
- One organisation per user is read (the oldest membership). Multi-organisation switching is not built.
- A password-based sign-in with no MFA, no password reset page and no rate limiting beyond Supabase's own defaults.
- The repo is public and Vercel is on the Hobby plan (non-commercial); unchanged by this work.

## Cost
Free plan, Nano compute: $0/month. Nothing here needs a paid add-on, a background worker or a scheduled job. Watch
database size (500 MB), monthly active users (50,000) and egress in the dashboard; the free project pauses after a
week of inactivity.
