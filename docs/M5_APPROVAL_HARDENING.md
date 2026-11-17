# M5 approval hardening: a database guard for Amazon insight approvals (PROPOSAL)

Status: **proposal only. Not applied anywhere, and deliberately NOT part of `supabase/migrations/20261111000000_amazon_intelligence.sql`.** There is no migration file for it yet. If approved it becomes a second, separate migration that runs after the Amazon one (it reads `public.amazon_insights`).
Tests: `tests/m5-approval-guard.test.ts` runs the SQL below, taken straight from this document, on top of the real foundation migration and the Amazon migration, in an in-process Postgres (PGlite). That proves the SQL, not the hosted service.

## 1. The gap it closes
The application already refuses to queue a sandbox insight (`amazonQueueInsight`) and scopes insight reads by environment. The database cannot enforce that on its own: `approvals` has no environment column, and its insert policy (`approvals_insert`) lets any writer queue a pending row with arbitrary `meta`. A direct API call, a bug, or a future code path could therefore put an approval in front of an approver that claims to be an Amazon insight but is simulated, invented, or belongs to another organisation. This trigger makes the database check that claim.

## 2. What it does (and only this)
It runs `BEFORE INSERT` on `public.approvals`, **only when `meta ->> 'kind' = 'amazon_insight'`** (a `WHEN` clause, so for every other row the function is never called). For such a row it requires all of:

| Check | Refused with |
|---|---|
| `generated_by = 'amazon'` | `an Amazon insight approval must be generated_by amazon` (23514) |
| `meta ->> 'ref'` is present and a well-formed UUID | `Amazon insight reference is missing or invalid` (23514) |
| An `amazon_insights` row with `id = ref` and `org_id =` the approval's own `org_id` exists | `Amazon insight not found in this organisation` (23503). Missing and other-organisation cases give the **same** message, so the existence of another organisation's insight is not revealed |
| That insight has `environment = 'production'` | `sandbox Amazon insights cannot be queued for approval` (23514) |

The function is `SECURITY DEFINER` with an empty `search_path`, so the lookup does not depend on the caller's RLS and the answer is the same for every role, including a statement run with no signed-in user (the SQL editor). The insight row is read `FOR SHARE`, so it cannot be deleted between the check and the insert. Nothing is written by the function.

Defensive details: both comparisons use `IS DISTINCT FROM`, so a NULL `generated_by` or a NULL environment is refused instead of slipping through a three-valued `<>` (neither column can be NULL today; this keeps the guard safe if that ever changed). `EXECUTE` is revoked from `public`, `anon`, `authenticated` and `service_role`; the function is also a trigger function, which Postgres refuses to run from `SELECT` or `CALL`.

## 3. Proposed SQL

```sql
-- Proposed second migration (NOT applied). Requires 20261111000000_amazon_intelligence.sql.
-- Adds one function and one trigger. No table, column, constraint, index, policy or grant is changed.
create or replace function private.amazon_approval_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  ref text := new.meta ->> 'ref';
  env text;
begin
  if new.generated_by is distinct from 'amazon' then
    raise exception 'an Amazon insight approval must be generated_by amazon' using errcode = '23514';
  end if;
  if ref is null or ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Amazon insight reference is missing or invalid' using errcode = '23514';
  end if;

  -- Same organisation only, and the same message whether the insight is missing or belongs to someone else.
  select i.environment into env
    from public.amazon_insights i
   where i.id = ref::uuid and i.org_id = new.org_id
     for share;
  if not found then
    raise exception 'Amazon insight not found in this organisation' using errcode = '23503';
  end if;
  if env is distinct from 'production' then
    raise exception 'sandbox Amazon insights cannot be queued for approval' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.amazon_approval_guard() from public, anon, authenticated, service_role;

create trigger approvals_amazon_guard
  before insert on public.approvals
  for each row
  when (new.meta ->> 'kind' = 'amazon_insight')
  execute function private.amazon_approval_guard();
```

## 4. Exact effect on the existing `approvals` table

| Aspect | Effect |
|---|---|
| Columns, types, defaults, checks, the `unique (org_id, id)` key, indexes | **None.** |
| RLS policies (`approvals_read`, `approvals_insert`), grants (`select, insert`), the absence of update/delete policies | **None.** A row must still pass `approvals_insert` first. |
| `decide_approval()` | **None.** It never touches `meta` or inserts approvals, and the trigger is insert-only. Deciding an Amazon insight approval behaves as before. |
| Rows already in the table | **None.** Not re-checked; the trigger is not a constraint. |
| Inserts for `b2c`, `b2b`, `content`, `crm`, and `amazon` rows whose `meta.kind` is anything else or absent (including the demo-era per-row Amazon actions) | **None.** The `WHEN` clause skips them; the function is not called. Tested. |
| Inserts with `meta.kind = 'amazon_insight'` | Now validated as in section 2. Any caller, including the service role and the SQL editor, is subject to it (a trigger is not bypassed by RLS bypass). |
| Added objects | `private.amazon_approval_guard()` and trigger `approvals_amazon_guard`. Nothing else. |
| Cost | One indexed primary-key lookup per Amazon insight approval; nothing for other inserts. |
| Rollback | `drop trigger approvals_amazon_guard on public.approvals; drop function private.amazon_approval_guard();` restores today's behaviour exactly. |

Note the one structural change: this adds a trigger to an existing table, which the Amazon migration itself deliberately never does. That is why it is a separate proposal with its own approval.

## 5. What it does not cover (stated, not assumed)
- **Updates.** A later `UPDATE` of `meta`, `org_id` or `generated_by` is not checked. The app has no such path (no update policy exists; `decide_approval` changes only status, title and preview), so only a direct administrator or service-role statement could. Covering it would add `BEFORE UPDATE OF meta, org_id, generated_by`; not included to keep this narrow.
- **Insight state.** It does not require the insight to be unsubmitted or unlinked; duplicate-queue prevention stays in the application (pending `meta.ref` check and insight status).
- **Deleted insights.** Deleting an insight afterwards leaves its approval in place (the foreign key points the other way). The approval still carries its own preview text.
- **Content.** It does not inspect `title`, `preview` or other `meta` fields. The content claim guard remains in the application.
- **Hosted behaviour.** Tested only in PGlite on the real foundation SQL. Not run on Supabase (M1 is deferred), so apply to staging first and re-run the same cases.
