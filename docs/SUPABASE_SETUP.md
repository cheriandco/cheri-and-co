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
4. Create the demo organisation and the first user (SQL editor, as administrator):
   ```sql
   insert into public.organizations (name, is_demo) values ('Cheri & Co. (demo workspace)', true) returning id;
   -- Authentication > Users > Add user (invite). Then:
   insert into public.memberships (org_id, user_id, role) values ('<org id>', '<auth user id>', 'owner');
   ```
5. Set `AUTH_MODE=required` plus the two public variables locally, run `npm run dev`, sign in, and confirm that a user
   with no membership sees "No workspace available yet".
6. Only then set the same variables in Vercel (not done here; deployment settings were not touched).

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
