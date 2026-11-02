# Supabase foundation: setup and security

Status: **built and tested locally. The foundation migration was applied to project `ciodkacwdbktuimriuss` by the project owner and
`docs/rls_live_check.sql` passed 95/95 there (reported by the owner; it predates Slices 2 to 4, which changed no schema).** Everything else here
(real sign-in, the Slice 1 to 4 queries as PostgREST runs them, the approval round trip) has **not** been run against the hosted service. The SQL was
executed and tested in an in-process Postgres (`tests/rls.test.ts`); the sign-in and data code were tested with a fake client.

## What exists
- `supabase/migrations/20261101000000_foundation.sql`: 13 tables, all with Row Level Security, no sample rows.
  Tables: `organizations`, `profiles`, `memberships`, `customers`, `products`, `retailers`, `leads`, `orders`, `tasks`,
  `approvals`, `content_items`, `agent_activity`, `audit_log`.
- `AUTH_MODE=demo` (default): the public demo, unchanged. No sign-in, sample data only, nothing stored.
- `AUTH_MODE=required`: every page and API call needs a verified Supabase session and a row in `memberships`.
- Real (non-demo) organisations read their own rows for tasks, approvals, customers, retailers, leads, products, content posts and orders (see "What is connected" below). B2C Sales and Amazon Intelligence have no data source yet. The built-in sample data is shown only to demo organisations and the public demo.

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
  A post is shown as approved or rejected only when an approval whose `meta.postId` names that post says so; a status or `approval_id` written straight to
  the table (writers are allowed to update `content_items`) is not believed and shows as a draft. Edits made straight to an already approved post's caption are not detected (no schema change was made to block them).
  Gaps: no engagement/metrics columns (Performance is "not available"); no asset storage; no brand-rule table; "Simulate publish" is
  demo-only (the app never posts); the Content pack generator uses the sample catalogue so it is hidden for live orgs; posts on
  Pinterest, Email and Amazon A+ are allowed by the table but have no screen; no delete UI; a product price or stock left blank stays null.
- Slice 4: Orders (`orders` table), through the API only: `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders`,
  `PATCH /api/orders/:id` (status only); writes need `orders:write` (owner/admin/approver/staff). There is no Orders screen and
  no sample orders. Business rules (agreed): a customer's *purchases* are their orders except `cancelled` and `returned`; *revenue*
  counts `delivered` orders only (statuses in the table: new, paid, shipped, delivered, cancelled, returned). Reports shows a live
  Sales section from delivered orders (revenue, order count, average order value, six weekly bars, compared with the six weeks
  before); the other Reports sections stay sample-only and are not shown to live organisations. Orders are dated by `ordered_at`
  because the table stores no delivery date. `line_items` is free-form JSON (the table defines no shape). No delete.
- Not connected yet: the agents' own inputs (B2C conversations, Amazon data, B2B discovery).
  For a live organisation these show "Not connected yet" or empty, never sample data.

## Known limitations
- Sample data lives in server memory and is shown only to demo organisations and the public demo. B2C Sales and Amazon Intelligence have no stored data yet.
- Lists are read in pages of 1000 rows; a single list of more than 10,000 records is refused with an error rather than shown incomplete. Tasks cannot be assigned to a person yet (the assignee is not stored).
- The prohibited-claims guard for content runs in the application, not inside `decide_approval()`.
- A post counts as approved only if its approval's `meta.postId` equals the post's id. Approvals created before that field existed (legacy approvals without `meta.postId`) do not approve anything: their post shows as a draft, even if the approval itself was approved. A post stuck at pending approval can be edited back to a draft and submitted again. No such data is known to exist on the hosted project (unverified).
- Postponing a task adds one day to its current due date. An overdue task therefore stays overdue (10 days overdue becomes 9); a task with no due date gets one day from now.
- One organisation per user is read (the oldest membership). Multi-organisation switching is not built.
- A password-based sign-in with no MFA, no password reset page and no rate limiting beyond Supabase's own defaults.
- The repo is public and Vercel is on the Hobby plan (non-commercial); unchanged by this work.

## Cost
Free plan, Nano compute: $0/month. Nothing here needs a paid add-on, a background worker or a scheduled job. Watch
database size (500 MB), monthly active users (50,000) and egress in the dashboard; the free project pauses after a
week of inactivity.
