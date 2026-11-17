-- =====================================================================================================================
-- Cheri & Co. -- READ-ONLY security AUDIT of the live Supabase schema (Row Level Security, grants, policies)
--
-- WHERE: Supabase dashboard > project ciodkacwdbktuimriuss > SQL Editor.  HOW: paste this whole file, click Run once.
--
-- READ-ONLY BY CONSTRUCTION: the file is ONE SELECT statement (a WITH query). It has no transaction commands and changes
-- nothing: no rows, no settings, no policies, no grants, no functions. It only reads the system catalogues (pg_class,
-- pg_policies, pg_proc, pg_attribute, pg_constraint, pg_roles) and asks Postgres "would role X be allowed to ...?" through
-- has_table_privilege() and its relatives, which are pure lookups. It creates no fixtures and no temporary objects.
-- (The words INSERT, UPDATE, DELETE, TRUNCATE below appear only as privilege NAMES inside text values, never as commands.)
--
-- HOW IT DIFFERS FROM docs/rls_live_check.sql: that script PROVES behaviour (it builds fake users inside a transaction that
-- is rolled back and tries to read and write as each role). This audit INSPECTS configuration only: it can tell you a
-- table has RLS off, that anon holds a grant, or that a policy is "using (true)", but it cannot prove that an owner of
-- organisation A really cannot read organisation B. Run both. Use this one whenever you want a quick, zero-risk look,
-- for example after any schema change.
--
-- OUTPUT: one result table, sorted so the answer is at the top:
--   row 1            SUMMARY  : the count of FAIL / WARN / INFO / PASS and a one-line RESULT
--   next rows        FAIL     : something is unsafe or missing: fix before going live
--   then             WARN     : review (usually safe but unusual)
--   then             INFO     : facts worth knowing (for example a table the audit did not expect)
--   last             PASS
-- Columns: status | section | check_name | object | detail
--
-- SCOPE: every ordinary table in schema public (new tables are picked up automatically), plus public/private functions and
-- public views. A table counts as a TENANT table when it has an org_id column; the checks assume the design in
-- supabase/migrations/20261101000000_foundation.sql (policies call private.is_member / can_write / can_decide / is_admin).
--
-- LIMITS (read these): policy checks are text checks on each policy's USING / WITH CHECK expression. A policy that mentions
-- org_id and a membership helper passes even if it combines them wrongly; that needs the behavioural script. This audit
-- does NOT see: Auth settings (sign-ups, providers), "Exposed schemas" in the API settings, Storage bucket policies, API keys,
-- or anything outside the database. Check those in the dashboard (docs/LIVE_READINESS_RUNBOOK.md, steps 1 and 2).
-- =====================================================================================================================

with
-- ---- catalogue facts --------------------------------------------------------------------------------------------------
-- Application tables: ordinary and partitioned tables in public, excluding tables owned by extensions (for example postgis).
tbl as (
  select c.oid, c.relname::text as name, c.relrowsecurity as rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
),
-- The two roles the Data API uses. If a role does not exist (not a Supabase project) it simply produces no rows.
api_role as (
  select r.rolname::text as rolname from pg_roles r where r.rolname in ('anon', 'authenticated')
),
-- Tenant tables: those with an org_id column.
org_col as (
  select a.attrelid as oid, a.attnotnull as not_null
  from pg_attribute a
  join tbl on tbl.oid = a.attrelid
  where a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped
),
-- Every policy in public, with the expression text normalised (null becomes empty).
pol as (
  select p.tablename::text as tbl, p.policyname::text as pol, p.cmd::text as cmd, p.roles::text[] as roles,
         coalesce(p.qual, '') as qual, coalesce(p.with_check, '') as wc,
         (p.qual is not null) as has_qual, (p.with_check is not null) as has_wc
  from pg_policies p
  where p.schemaname = 'public'
),
-- Functions in public and private, excluding extension-owned ones.
fn as (
  select p.oid, n.nspname::text as sch, p.proname::text as name, p.prosecdef as definer,
         exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as u(cfg) where u.cfg like 'search_path=%') as fixed_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
-- Views and materialised views in public.
vw as (
  select c.oid, c.relname::text as name, c.relkind::text as kind,
         exists (select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) as u(o) where u.o in ('security_invoker=true', 'security_invoker=on')) as invoker
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
),
-- Names the design expects to exist (13 foundation tables).
expected(name) as (
  values ('organizations'), ('profiles'), ('memberships'), ('customers'), ('products'), ('retailers'), ('leads'),
         ('orders'), ('tasks'), ('approvals'), ('content_items'), ('agent_activity'), ('audit_log')
),
-- Privileges signed-in users must NOT hold on specific tables (the app's design: see the foundation migration).
forbidden(name, priv) as (
  values ('audit_log', 'INSERT'), ('audit_log', 'UPDATE'), ('audit_log', 'DELETE'), ('audit_log', 'TRUNCATE'),
         ('agent_activity', 'UPDATE'), ('agent_activity', 'DELETE'), ('agent_activity', 'TRUNCATE'),
         ('memberships', 'INSERT'), ('memberships', 'UPDATE'), ('memberships', 'DELETE'), ('memberships', 'TRUNCATE'),
         ('organizations', 'INSERT'), ('organizations', 'UPDATE'), ('organizations', 'DELETE'), ('organizations', 'TRUNCATE'),
         ('approvals', 'UPDATE'), ('approvals', 'DELETE'), ('approvals', 'TRUNCATE'),
         ('profiles', 'INSERT'), ('profiles', 'DELETE'), ('profiles', 'TRUNCATE')
),
-- Text patterns used by the policy checks.
re as (
  select 'is_member|can_write|can_decide|is_admin|role_in|shares_org|memberships'::text as membership,
         'auth\.uid|is_member|can_write|can_decide|is_admin|role_in|shares_org|memberships'::text as identity
),

-- ---- the checks (each branch returns: section, check_name, object, status, detail) -------------------------------------
checks as (

  -- 0. Sanity: the audit found tables at all.
  select '0 Sanity'::text as section, 'application tables found in schema public'::text as check_name, 'public'::text as object,
         case when (select count(*) from tbl) > 0 then 'PASS' else 'FAIL' end as status,
         (select count(*) from tbl)::text || ' table(s) found' as detail

  -- 1. RLS enabled on every application table.
  union all
  select '1 RLS status', 'row level security is enabled', t.name,
         case when t.rls then 'PASS' else 'FAIL' end,
         case when t.rls then 'RLS is on'
              else 'RLS is OFF: any API role holding a grant can read and write every row of this table' end
  from tbl t
  union all
  select '1 RLS status', 'RLS is on but the table has no policy', t.name, 'WARN',
         'default deny: only the table owner and service role can use it (safe, but the app cannot read it)'
  from tbl t
  where t.rls and not exists (select 1 from pol where pol.tbl = t.name)

  -- 2. Anonymous (signed-out) and PUBLIC access.
  union all
  select '2 Anonymous and public access', 'role anon holds no privilege on the table', t.name,
         case when has_any_column_privilege(r.rolname, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
                or has_table_privilege(r.rolname, t.oid, 'DELETE,TRUNCATE,TRIGGER') then 'FAIL' else 'PASS' end,
         case when has_any_column_privilege(r.rolname, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
                or has_table_privilege(r.rolname, t.oid, 'DELETE,TRUNCATE,TRIGGER')
              then 'anon (signed-out visitors, and anything granted to PUBLIC) holds a privilege here'
              else 'no grant to anon, directly or through PUBLIC' end
  from tbl t
  join api_role r on r.rolname = 'anon'
  union all
  select '2 Anonymous and public access', 'role anon exists', 'anon', 'INFO',
         'the anon role was not found: this does not look like a Supabase project, so the anon checks were skipped'
  where not exists (select 1 from api_role where rolname = 'anon')
  union all
  select '2 Anonymous and public access', 'no policy is open to anon or public', t.name,
         case when exists (select 1 from pol where pol.tbl = t.name and ('anon' = any (pol.roles) or 'public' = any (pol.roles)))
              then 'FAIL' else 'PASS' end,
         case when exists (select 1 from pol where pol.tbl = t.name and ('anon' = any (pol.roles) or 'public' = any (pol.roles)))
              then 'a policy applies to anon or to PUBLIC (everyone): '
                   || coalesce((select string_agg(pol.pol, ', ') from pol where pol.tbl = t.name and ('anon' = any (pol.roles) or 'public' = any (pol.roles))), '')
              else 'every policy is limited to named roles other than anon/public' end
  from tbl t
  union all
  select '2 Anonymous and public access', 'role anon cannot use the private helper schema', 'schema private',
         case when has_schema_privilege(r.rolname, n.nspname, 'USAGE') then 'FAIL' else 'PASS' end,
         case when has_schema_privilege(r.rolname, n.nspname, 'USAGE')
              then 'anon has USAGE on schema private (its helper functions should not be reachable signed out)'
              else 'anon has no access to schema private' end
  from pg_namespace n
  join api_role r on r.rolname = 'anon'
  where n.nspname = 'private'
  union all
  select '2 Anonymous and public access', 'role anon cannot execute any function', f.sch || '.' || f.name,
         case when has_function_privilege(r.rolname, f.oid, 'EXECUTE') then 'FAIL' else 'PASS' end,
         case when has_function_privilege(r.rolname, f.oid, 'EXECUTE')
              then 'anon (or PUBLIC) may execute this function; revoke execute from public and anon'
              else 'not executable by anon' end
  from fn f
  join api_role r on r.rolname = 'anon'

  -- 3. Signed-in users: privileges that Row Level Security does NOT limit.
  union all
  select '3 Signed-in user grants', 'authenticated has no TRUNCATE or TRIGGER (RLS does not limit TRUNCATE)', t.name,
         case when has_table_privilege(r.rolname, t.oid, 'TRUNCATE,TRIGGER') then 'FAIL' else 'PASS' end,
         case when has_table_privilege(r.rolname, t.oid, 'TRUNCATE,TRIGGER')
              then 'TRUNCATE ignores RLS: a signed-in user could empty the whole table'
              else 'no TRUNCATE/TRIGGER grant' end
  from tbl t
  join api_role r on r.rolname = 'authenticated'

  -- 4. Policy safety (every policy in public).
  union all
  select '4 Policy safety', 'USING expression is not constant true', p.tbl || '.' || p.pol,
         case when regexp_replace(p.qual, '[()[:space:]]', '', 'g') ~* '^true$' then 'FAIL' else 'PASS' end,
         case when regexp_replace(p.qual, '[()[:space:]]', '', 'g') ~* '^true$'
              then 'USING (true): every row is visible/changeable to the roles in this policy (' || p.cmd || ')'
              else p.cmd || ': ' || left(p.qual, 160) end
  from pol p
  where p.has_qual
  union all
  select '4 Policy safety', 'WITH CHECK expression is not constant true', p.tbl || '.' || p.pol,
         case when regexp_replace(p.wc, '[()[:space:]]', '', 'g') ~* '^true$' then 'FAIL' else 'PASS' end,
         case when regexp_replace(p.wc, '[()[:space:]]', '', 'g') ~* '^true$'
              then 'WITH CHECK (true): any row may be written, including into another organisation (' || p.cmd || ')'
              else p.cmd || ': ' || left(p.wc, 160) end
  from pol p
  where p.has_wc
  union all
  select '4 Policy safety', 'policy does not trust user-editable metadata', p.tbl || '.' || p.pol,
         case when (p.qual || ' ' || p.wc) ~* 'user_metadata|raw_user_meta_data' then 'FAIL' else 'PASS' end,
         case when (p.qual || ' ' || p.wc) ~* 'user_metadata|raw_user_meta_data'
              then 'uses user_metadata: a user can edit their own metadata, so this can be forged'
              else 'no reference to user-editable metadata' end
  from pol p
  union all
  select '4 Policy safety', 'non-tenant table policy is tied to the signed-in user or a membership check', p.tbl || '.' || p.pol,
         case when (p.qual || ' ' || p.wc) ~* (select identity from re) then 'PASS' else 'WARN' end,
         case when (p.qual || ' ' || p.wc) ~* (select identity from re)
              then p.cmd || ': ' || left(p.qual || p.wc, 160)
              else 'table has no org_id and this policy mentions neither auth.uid() nor a membership helper: review it' end
  from pol p
  join tbl t on t.name = p.tbl
  where not exists (select 1 from org_col o where o.oid = t.oid)

  -- 5. Tenant isolation (tables with an org_id column).
  union all
  select '5 Tenant isolation', 'org_id is NOT NULL', t.name,
         case when o.not_null then 'PASS' else 'FAIL' end,
         case when o.not_null then 'org_id cannot be null'
              else 'org_id is nullable: a row with no organisation escapes every org_id policy' end
  from tbl t
  join org_col o on o.oid = t.oid
  union all
  select '5 Tenant isolation', 'org_id references organizations', t.name,
         case when exists (
                select 1 from pg_constraint k
                join pg_class oc on oc.oid = k.confrelid
                join pg_namespace ons on ons.oid = oc.relnamespace
                where k.conrelid = t.oid and k.contype = 'f' and oc.relname = 'organizations' and ons.nspname = 'public'
                  and (select a.attnum from pg_attribute a where a.attrelid = t.oid and a.attname = 'org_id') = any (k.conkey)
              ) then 'PASS' else 'WARN' end,
         'a foreign key from org_id to public.organizations stops rows pointing at a non-existent organisation'
  from tbl t
  join org_col o on o.oid = t.oid
  union all
  select '5 Tenant isolation', 'table has a SELECT policy scoped by org_id and membership', t.name,
         case when exists (select 1 from pol p where p.tbl = t.name and p.cmd in ('SELECT', 'ALL')
                           and p.qual ~* 'org_id' and p.qual ~* (select membership from re)) then 'PASS' else 'WARN' end,
         case when exists (select 1 from pol p where p.tbl = t.name and p.cmd in ('SELECT', 'ALL')
                           and p.qual ~* 'org_id' and p.qual ~* (select membership from re))
              then 'reads are limited to members of the row''s organisation'
              else 'no SELECT policy compares org_id with a membership check: members may be unable to read, or the policy is shaped differently (review)' end
  from tbl t
  join org_col o on o.oid = t.oid
  union all
  select '5 Tenant isolation', 'USING is scoped by org_id and a membership check', p.tbl || '.' || p.pol,
         case when p.qual ~* 'org_id' and p.qual ~* (select membership from re) then 'PASS' else 'FAIL' end,
         case when p.qual ~* 'org_id' and p.qual ~* (select membership from re)
              then p.cmd || ': ' || left(p.qual, 160)
              else p.cmd || ' policy on a tenant table does not compare org_id with a membership check: ' || left(p.qual, 160) end
  from pol p
  join tbl t on t.name = p.tbl
  join org_col o on o.oid = t.oid
  where p.has_qual
  union all
  select '5 Tenant isolation', 'WITH CHECK is scoped by org_id and a membership check', p.tbl || '.' || p.pol,
         case when p.wc ~* 'org_id' and p.wc ~* (select membership from re) then 'PASS' else 'FAIL' end,
         case when p.wc ~* 'org_id' and p.wc ~* (select membership from re)
              then p.cmd || ': ' || left(p.wc, 160)
              else p.cmd || ' policy can write rows without checking org_id against a membership: ' || left(p.wc, 160) end
  from pol p
  join tbl t on t.name = p.tbl
  join org_col o on o.oid = t.oid
  where p.has_wc
  union all
  select '5 Tenant isolation', 'INSERT policy has a WITH CHECK', p.tbl || '.' || p.pol,
         case when p.has_wc then 'PASS' else 'FAIL' end,
         case when p.has_wc then 'INSERT is checked' else 'INSERT policy with no WITH CHECK: anyone it applies to can insert any row' end
  from pol p
  join tbl t on t.name = p.tbl
  join org_col o on o.oid = t.oid
  where p.cmd = 'INSERT'

  -- 6. Functions.
  union all
  select '6 Functions', 'SECURITY DEFINER function has a fixed search_path', f.sch || '.' || f.name,
         case when f.fixed_path then 'PASS' else 'FAIL' end,
         case when f.fixed_path then 'search_path is pinned'
              else 'SECURITY DEFINER without a pinned search_path can be hijacked by an object a caller creates' end
  from fn f
  where f.definer
  union all
  select '6 Functions', 'SECURITY DEFINER function callable by signed-in users (review)', f.sch || '.' || f.name, 'INFO',
         'runs with its owner''s rights and bypasses RLS; confirm it checks auth.uid() and organisation membership inside'
  from fn f
  join api_role r on r.rolname = 'authenticated'
  where f.definer and has_function_privilege(r.rolname, f.oid, 'EXECUTE')

  -- 7. Views and materialised views (they can bypass RLS).
  union all
  select '7 Views', 'view respects the caller''s RLS or is not readable through the API', v.name || ' (' || r.rolname || ')',
         case when v.kind = 'm' or not v.invoker then 'FAIL' else 'PASS' end,
         case when v.kind = 'm' then 'materialised views have no RLS; readable by ' || r.rolname
              when not v.invoker then 'view runs with its owner''s rights (no security_invoker), so it bypasses RLS for ' || r.rolname
              else 'security_invoker is on' end
  from vw v
  join api_role r on has_table_privilege(r.rolname, v.oid, 'SELECT')

  -- 8. Expected objects.
  union all
  select '8 Expected objects', 'expected table exists', e.name,
         case when exists (select 1 from tbl t where t.name = e.name) then 'PASS' else 'FAIL' end,
         case when exists (select 1 from tbl t where t.name = e.name) then 'present' else 'missing from schema public' end
  from expected e
  union all
  select '8 Expected objects', 'table not in the foundation list (covered by the generic checks)', t.name, 'INFO',
         'extra table: the generic RLS, grant and policy checks above already apply to it'
  from tbl t
  where t.name not in (select name from expected)
  union all
  select '8 Expected objects', 'public.decide_approval exists and is not callable by anon', 'public.decide_approval',
         case when exists (select 1 from fn where sch = 'public' and name = 'decide_approval')
               and not exists (select 1 from fn join api_role r on r.rolname = 'anon' where fn.sch = 'public' and fn.name = 'decide_approval' and has_function_privilege(r.rolname, fn.oid, 'EXECUTE'))
              then 'PASS' else 'FAIL' end,
         'approval decisions must go through this function (it checks role and organisation and writes the audit row)'

  -- 9. Project invariants: privileges signed-in users must not hold.
  union all
  select '9 Project invariants', 'authenticated must not hold ' || f.priv, f.name,
         case when case when f.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                        then has_any_column_privilege(r.rolname, t.oid, f.priv)
                        else has_table_privilege(r.rolname, t.oid, f.priv) end
              then 'FAIL' else 'PASS' end,
         case when case when f.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                        then has_any_column_privilege(r.rolname, t.oid, f.priv)
                        else has_table_privilege(r.rolname, t.oid, f.priv) end
              then 'signed-in users hold ' || f.priv || ' here, which the design forbids (history is append-only; memberships and organisations are written by an administrator only; approvals change only through decide_approval)'
              else 'not granted' end
  from forbidden f
  join tbl t on t.name = f.name
  join api_role r on r.rolname = 'authenticated'
),

-- ---- summary ---------------------------------------------------------------------------------------------------------------
counts as (
  select count(*) filter (where status = 'FAIL') as fails,
         count(*) filter (where status = 'WARN') as warns,
         count(*) filter (where status = 'INFO') as infos,
         count(*) filter (where status = 'PASS') as passes
  from checks
)

select status, section, check_name, object, detail
from (
  select 0 as ord, 'SUMMARY'::text as status, 'SUMMARY'::text as section,
         case when fails = 0 then 'RESULT: NO FAILS' else 'RESULT: ' || fails || ' FAIL(S), fix before going live' end as check_name,
         ''::text as object,
         fails || ' FAIL, ' || warns || ' WARN, ' || infos || ' INFO, ' || passes || ' PASS (' || (fails + warns + infos + passes) || ' checks). '
           || case when fails = 0 then 'Configuration looks sound; this audit cannot prove behaviour, so also run docs/rls_live_check.sql.'
                   else 'Start with the FAIL rows below.' end as detail
  from counts
  union all
  select case c.status when 'FAIL' then 1 when 'WARN' then 2 when 'INFO' then 3 else 4 end, c.status, c.section, c.check_name, c.object, c.detail
  from checks c
) x
order by ord, section, object, check_name;
