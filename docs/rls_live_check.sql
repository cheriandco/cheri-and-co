-- =====================================================================================================================
-- Cheri & Co. — LIVE database security check (Row Level Security, roles, approvals, audit)
--
-- WHERE: Supabase dashboard > project ciodkacwdbktuimriuss > SQL Editor.  HOW: paste this WHOLE file, click Run ONCE.
-- Run the entire script in a single run so the transaction and the final ROLLBACK stay together. Do not run
-- selected parts, and do not run it twice at once.
--
-- SAFETY
--  * One explicit transaction (BEGIN ... ROLLBACK). Nothing is kept: every fixture row disappears at the ROLLBACK.
--  * Fixtures are fake (emails end in @cheri-security-test.invalid, names start with SECTEST).
--  * No service-role key, no RLS changes, no policy changes, no Auth settings changed, no real users.
--  * It reads the real tables, policies, grants and functions created by 20261101000000_foundation.sql.
-- Each test switches to the same database role the app uses (authenticated, or anon for signed-out) and sets the
-- JWT claims (sub) exactly as Supabase does, so auth.uid() and every policy behave as they would for a real user.
--
-- OUTPUT: a table, one row per check, PASS/FAIL, with a SUMMARY row on top.
-- The report is the last statement before ROLLBACK. If the editor shows only "Success. No rows returned", it displayed
-- the ROLLBACK instead of the report: nothing was kept and nothing is wrong, but tell Claude so an alternative output
-- mode can be prepared. If a run stops with an error, the transaction is left open: run  ROLLBACK;  on its own.
-- =====================================================================================================================

begin;

-- ---- harness (temporary objects, gone after the rollback) -----------------------------------------------------------
create temp table fx (k text primary key, id uuid not null);
create temp table sec_results (n serial, section text, test text, expected text, actual text, pass boolean);

insert into fx (k, id) values
  ('orgA',     'aaaaaaaa-0000-4000-8000-00000000000a'), ('orgB',     'bbbbbbbb-0000-4000-8000-00000000000b'),
  ('ownerA',   'a1000000-0000-4000-8000-000000000001'), ('adminA',   'a1000000-0000-4000-8000-000000000002'),
  ('approverA','a1000000-0000-4000-8000-000000000003'), ('staffA',   'a1000000-0000-4000-8000-000000000004'),
  ('viewerA',  'a1000000-0000-4000-8000-000000000005'), ('ownerB',   'b1000000-0000-4000-8000-000000000001'),
  ('loner',    'c1000000-0000-4000-8000-000000000001'),
  ('custA',    'a2000000-0000-4000-8000-000000000001'), ('custB',    'b2000000-0000-4000-8000-000000000001'),
  ('retA',     'a3000000-0000-4000-8000-000000000001'), ('retB',     'b3000000-0000-4000-8000-000000000001'),
  ('apA1',     'a4000000-0000-4000-8000-000000000001'), ('apA2',     'a4000000-0000-4000-8000-000000000002'),
  ('apA3',     'a4000000-0000-4000-8000-000000000003'), ('apB',      'b4000000-0000-4000-8000-000000000001'),
  ('taskA1',   'a5000000-0000-4000-8000-000000000001'), ('taskA2',   'a5000000-0000-4000-8000-000000000002'),
  ('taskB',    'b5000000-0000-4000-8000-000000000001');

-- chk(): runs p_sql as p_role (authenticated | anon | NULL = the editor's own role) with the JWT sub of fx[p_who],
-- then records PASS/FAIL. p_sql must return exactly one text/scalar value; {tokens} are replaced with fixture ids.
--   p_err IS NULL     -> the statement must succeed and return p_expect
--   p_err IS NOT NULL -> the statement must fail with a message matching the regex p_err
create function pg_temp.chk(p_section text, p_test text, p_role text, p_who text, p_sql text,
                            p_expect text default null, p_err text default null)
returns void language plpgsql as $f$
declare r record; v_sql text := p_sql; v_sub uuid; v_actual text; v_msg text; v_pass boolean;
begin
  for r in select k, id from fx loop v_sql := replace(v_sql, '{' || r.k || '}', r.id::text); end loop;
  select id into v_sub from fx where k = p_who;
  perform set_config('request.jwt.claims',
    case when v_sub is null then '{}' else json_build_object('sub', v_sub, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub::text, ''), true);
  if p_role is not null then execute format('set local role %I', p_role); end if;
  begin
    execute v_sql into v_actual;
  exception when others then
    v_msg := sqlerrm; v_actual := null;
  end;
  if p_role is not null then reset role; end if;
  if p_err is not null then
    v_pass := v_msg is not null and v_msg ~* p_err;
    insert into sec_results (section, test, expected, actual, pass)
    values (p_section, p_test, 'error matching: ' || p_err, coalesce('error: ' || v_msg, 'NO ERROR (returned ' || coalesce(v_actual, 'null') || ')'), v_pass);
  else
    v_pass := v_msg is null and v_actual is not distinct from p_expect;
    insert into sec_results (section, test, expected, actual, pass)
    values (p_section, p_test, p_expect, coalesce('error: ' || v_msg, v_actual), v_pass);
  end if;
end $f$;

-- ---- fixtures: two organisations, users in several roles, a little data in each ---------------------------------
insert into auth.users (id, email)
  select id, k || '@cheri-security-test.invalid' from fx where k in ('ownerA','adminA','approverA','staffA','viewerA','ownerB','loner');
insert into public.organizations (id, name) select id, 'SECTEST ' || k from fx where k in ('orgA','orgB');
insert into public.memberships (org_id, user_id, role)
  select (select id from fx where k = o), (select id from fx where k = u), r
  from (values ('orgA','ownerA','owner'), ('orgA','adminA','admin'), ('orgA','approverA','approver'),
               ('orgA','staffA','staff'), ('orgA','viewerA','viewer'), ('orgB','ownerB','owner')) as m (o, u, r);
insert into public.customers (id, org_id, name)
  values ((select id from fx where k='custA'), (select id from fx where k='orgA'), 'SECTEST A customer'),
         ((select id from fx where k='custB'), (select id from fx where k='orgB'), 'SECTEST B customer');
insert into public.retailers (id, org_id, business)
  values ((select id from fx where k='retA'), (select id from fx where k='orgA'), 'SECTEST A retailer'),
         ((select id from fx where k='retB'), (select id from fx where k='orgB'), 'SECTEST B retailer');
insert into public.approvals (id, org_id, title, type, generated_by, preview)
  select (select id from fx where k = a), (select id from fx where k = o), 'SECTEST ' || a, 'Content', 'content', 'SECTEST preview'
  from (values ('apA1','orgA'), ('apA2','orgA'), ('apA3','orgA'), ('apB','orgB')) as v (a, o);
insert into public.tasks (id, org_id, title)
  select (select id from fx where k = t), (select id from fx where k = o), 'SECTEST ' || t
  from (values ('taskA1','orgA'), ('taskA2','orgA'), ('taskB','orgB')) as v (t, o);

-- ---- 0. Structure (as the editor's own role) -----------------------------------------------------------------------
select pg_temp.chk('0 Structure', 'all 13 expected tables have RLS enabled', null, null,
  $q$select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and c.relname in ('organizations','profiles','memberships','customers','products','retailers','leads','orders','tasks','approvals','content_items','agent_activity','audit_log')$q$, '13');
select pg_temp.chk('0 Structure', 'no table in schema public has RLS switched off', null, null,
  $q$select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity$q$, '0');
select pg_temp.chk('0 Structure', 'the anon role holds no privileges on any public table', null, null,
  $q$select count(*)::text from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'$q$, '0');
select pg_temp.chk('0 Structure', 'fixtures loaded (6 memberships across 2 test organisations)', null, null,
  $q$select count(*)::text from public.memberships where org_id in ('{orgA}', '{orgB}')$q$, '6');

-- ---- 1. Signed out (anon) -------------------------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array['organizations','profiles','memberships','customers','products','retailers','leads','orders','tasks','approvals','content_items','agent_activity','audit_log'] loop
    perform pg_temp.chk('1 Signed out', 'anon cannot read ' || t, 'anon', null, format('select count(*)::text from public.%I', t), null, 'permission denied');
  end loop;
end $do$;
select pg_temp.chk('1 Signed out', 'anon cannot insert a customer', 'anon', null,
  $q$with x as (insert into public.customers (org_id, name) values ('{orgA}', 'SECTEST anon') returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('1 Signed out', 'anon cannot call decide_approval', 'anon', null,
  $q$select status from public.decide_approval('{apA1}', 'approve')$q$, null, 'permission denied');
select pg_temp.chk('1 Signed out', 'anon cannot use the private helper schema', 'anon', null,
  $q$select private.is_member('{orgA}')::text$q$, null, 'permission denied');

-- ---- 2. Organisation isolation --------------------------------------------------------------------------------------
select pg_temp.chk('2 Isolation', 'owner of A sees A customers', 'authenticated', 'ownerA', $q$select count(*)::text from public.customers where org_id = '{orgA}'$q$, '1');
select pg_temp.chk('2 Isolation', 'owner of A sees ZERO B customers', 'authenticated', 'ownerA', $q$select count(*)::text from public.customers where org_id = '{orgB}'$q$, '0');
select pg_temp.chk('2 Isolation', 'owner of B sees ZERO A customers', 'authenticated', 'ownerB', $q$select count(*)::text from public.customers where org_id = '{orgA}'$q$, '0');
select pg_temp.chk('2 Isolation', 'owner of A sees only own organisation row', 'authenticated', 'ownerA', $q$select count(*)::text from public.organizations where id in ('{orgA}', '{orgB}')$q$, '1');
select pg_temp.chk('2 Isolation', 'A cannot read B approvals', 'authenticated', 'ownerA', $q$select count(*)::text from public.approvals where org_id = '{orgB}'$q$, '0');
select pg_temp.chk('2 Isolation', 'A cannot read B tasks', 'authenticated', 'ownerA', $q$select count(*)::text from public.tasks where org_id = '{orgB}'$q$, '0');
select pg_temp.chk('2 Isolation', 'user with no membership sees no customers', 'authenticated', 'loner', $q$select count(*)::text from public.customers where org_id in ('{orgA}', '{orgB}')$q$, '0');
select pg_temp.chk('2 Isolation', 'user with no membership sees no approvals', 'authenticated', 'loner', $q$select count(*)::text from public.approvals where org_id in ('{orgA}', '{orgB}')$q$, '0');
select pg_temp.chk('2 Isolation', 'user with no membership sees no organisations', 'authenticated', 'loner', $q$select count(*)::text from public.organizations where id in ('{orgA}', '{orgB}')$q$, '0');
select pg_temp.chk('2 Isolation', 'A cannot insert a row into B', 'authenticated', 'ownerA',
  $q$with x as (insert into public.customers (org_id, name) values ('{orgB}', 'SECTEST planted') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('2 Isolation', 'A cannot move its own row into B', 'authenticated', 'ownerA',
  $q$with x as (update public.customers set org_id = '{orgB}' where id = '{custA}' returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('2 Isolation', 'A updating a B customer changes 0 rows', 'authenticated', 'ownerA',
  $q$with x as (update public.customers set name = 'SECTEST hacked' where id = '{custB}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('2 Isolation', 'A deleting a B customer deletes 0 rows', 'authenticated', 'ownerA',
  $q$with x as (delete from public.customers where id = '{custB}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('2 Isolation', 'A deleting a B retailer deletes 0 rows', 'authenticated', 'ownerA',
  $q$with x as (delete from public.retailers where id = '{retB}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('2 Isolation', 'B customer is unchanged afterwards (checked as the editor role)', null, null,
  $q$select name from public.customers where id = '{custB}'$q$, 'SECTEST B customer');
select pg_temp.chk('2 Isolation', 'foreign key blocks an A lead pointing at a B retailer', null, null,
  $q$with x as (insert into public.leads (org_id, retailer_id) values ('{orgA}', '{retB}') returning 1) select count(*)::text from x$q$, null, 'foreign key');

-- ---- 3. Role-based write and delete ---------------------------------------------------------------------------------
select pg_temp.chk('3 Roles', 'viewer can read', 'authenticated', 'viewerA', $q$select count(*)::text from public.customers where org_id = '{orgA}'$q$, '1');
select pg_temp.chk('3 Roles', 'viewer cannot insert a customer', 'authenticated', 'viewerA',
  $q$with x as (insert into public.customers (org_id, name) values ('{orgA}', 'SECTEST viewer') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('3 Roles', 'viewer cannot insert a task', 'authenticated', 'viewerA',
  $q$with x as (insert into public.tasks (org_id, title) values ('{orgA}', 'SECTEST viewer') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('3 Roles', 'viewer update changes 0 rows', 'authenticated', 'viewerA',
  $q$with x as (update public.customers set city = 'X' where id = '{custA}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('3 Roles', 'staff can insert a task', 'authenticated', 'staffA',
  $q$with x as (insert into public.tasks (org_id, title) values ('{orgA}', 'SECTEST staff task') returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('3 Roles', 'approver can insert a task', 'authenticated', 'approverA',
  $q$with x as (insert into public.tasks (org_id, title) values ('{orgA}', 'SECTEST approver task') returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('3 Roles', 'staff can update a customer', 'authenticated', 'staffA',
  $q$with x as (update public.customers set city = 'Indore' where id = '{custA}' returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('3 Roles', 'staff delete deletes 0 rows (delete is owner/admin only)', 'authenticated', 'staffA',
  $q$with x as (delete from public.tasks where id = '{taskA2}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('3 Roles', 'the task still exists after the staff delete attempt', null, null,
  $q$select count(*)::text from public.tasks where id = '{taskA2}'$q$, '1');
select pg_temp.chk('3 Roles', 'approver delete deletes 0 rows', 'authenticated', 'approverA',
  $q$with x as (delete from public.tasks where id = '{taskA2}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('3 Roles', 'admin can delete', 'authenticated', 'adminA',
  $q$with x as (delete from public.tasks where id = '{taskA2}' returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('3 Roles', 'owner can delete', 'authenticated', 'ownerA',
  $q$with x as (delete from public.tasks where id = '{taskA1}' returning 1) select count(*)::text from x$q$, '1');

-- ---- 4. Memberships cannot be self-assigned; profiles; organisations -------------------------------------------------
select pg_temp.chk('4 Membership', 'owner cannot add themselves to another organisation', 'authenticated', 'ownerA',
  $q$with x as (insert into public.memberships (org_id, user_id, role) values ('{orgB}', '{ownerA}', 'owner') returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('4 Membership', 'user with no membership cannot grant themselves access', 'authenticated', 'loner',
  $q$with x as (insert into public.memberships (org_id, user_id, role) values ('{orgA}', '{loner}', 'owner') returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('4 Membership', 'staff cannot promote themselves', 'authenticated', 'staffA',
  $q$with x as (update public.memberships set role = 'owner' where user_id = '{staffA}' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('4 Membership', 'staff cannot delete memberships', 'authenticated', 'staffA',
  $q$with x as (delete from public.memberships where org_id = '{orgA}' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('4 Membership', 'staff sees only their own membership row', 'authenticated', 'staffA', $q$select count(*)::text from public.memberships where org_id = '{orgA}'$q$, '1');
select pg_temp.chk('4 Membership', 'admin sees all 5 memberships of their organisation', 'authenticated', 'adminA', $q$select count(*)::text from public.memberships where org_id = '{orgA}'$q$, '5');
select pg_temp.chk('4 Membership', 'another organisation sees none of A''s memberships', 'authenticated', 'ownerB', $q$select count(*)::text from public.memberships where org_id = '{orgA}'$q$, '0');
select pg_temp.chk('4 Profiles', 'staff can read a colleague''s profile', 'authenticated', 'staffA', $q$select count(*)::text from public.profiles where id = '{ownerA}'$q$, '1');
select pg_temp.chk('4 Profiles', 'staff cannot read a stranger''s profile', 'authenticated', 'staffA', $q$select count(*)::text from public.profiles where id = '{ownerB}'$q$, '0');
select pg_temp.chk('4 Profiles', 'staff can rename their own profile', 'authenticated', 'staffA',
  $q$with x as (update public.profiles set display_name = 'SECTEST renamed' where id = '{staffA}' returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('4 Profiles', 'staff cannot rename someone else (0 rows)', 'authenticated', 'staffA',
  $q$with x as (update public.profiles set display_name = 'SECTEST hijack' where id = '{ownerA}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('4 Profiles', 'only display_name is editable (other columns refused)', 'authenticated', 'staffA',
  $q$with x as (update public.profiles set created_at = now() where id = '{staffA}' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('4 Organisations', 'a signed-in user cannot create an organisation', 'authenticated', 'ownerA',
  $q$with x as (insert into public.organizations (name) values ('SECTEST rogue') returning 1) select count(*)::text from x$q$, null, 'permission denied');

-- ---- 5. Approvals and decide_approval() -----------------------------------------------------------------------------
select pg_temp.chk('5 Approvals', 'approvals cannot be updated directly, even by an owner', 'authenticated', 'ownerA',
  $q$with x as (update public.approvals set status = 'approved' where id = '{apA1}' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('5 Approvals', 'approvals cannot be deleted directly, even by an owner', 'authenticated', 'ownerA',
  $q$with x as (delete from public.approvals where id = '{apA1}' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('5 Approvals', 'staff can queue a pending approval', 'authenticated', 'staffA',
  $q$with x as (insert into public.approvals (org_id, title, type, generated_by, preview) values ('{orgA}', 'SECTEST queued', 'Content', 'content', 'x') returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('5 Approvals', 'staff cannot insert an already-approved approval', 'authenticated', 'staffA',
  $q$with x as (insert into public.approvals (org_id, title, type, generated_by, preview, status) values ('{orgA}', 'SECTEST sneaky', 'Content', 'content', 'x', 'approved') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('5 Approvals', 'viewer cannot queue an approval', 'authenticated', 'viewerA',
  $q$with x as (insert into public.approvals (org_id, title, type, generated_by, preview) values ('{orgA}', 'SECTEST v', 'Content', 'content', 'x') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('5 Decide', 'staff cannot decide', 'authenticated', 'staffA', $q$select status from public.decide_approval('{apA1}', 'approve')$q$, null, 'not authorized');
select pg_temp.chk('5 Decide', 'viewer cannot decide', 'authenticated', 'viewerA', $q$select status from public.decide_approval('{apA1}', 'approve')$q$, null, 'not authorized');
select pg_temp.chk('5 Decide', 'another organisation''s owner gets "not found" (id not revealed)', 'authenticated', 'ownerB', $q$select status from public.decide_approval('{apA1}', 'approve')$q$, null, 'not found');
select pg_temp.chk('5 Decide', 'user with no membership gets "not found"', 'authenticated', 'loner', $q$select status from public.decide_approval('{apA1}', 'approve')$q$, null, 'not found');
select pg_temp.chk('5 Decide', 'A owner cannot decide a B approval ("not found")', 'authenticated', 'ownerA', $q$select status from public.decide_approval('{apB}', 'approve')$q$, null, 'not found');
select pg_temp.chk('5 Decide', 'an invalid action is rejected', 'authenticated', 'ownerA', $q$select status from public.decide_approval('{apA1}', 'destroy')$q$, null, 'invalid action');
select pg_temp.chk('5 Decide', 'approver can approve', 'authenticated', 'approverA', $q$select status from public.decide_approval('{apA1}', 'approve', 'SECTEST ok')$q$, 'approved');
select pg_temp.chk('5 Decide', 'the approval wrote an audit row naming the real approver', null, null,
  $q$select count(*)::text from public.audit_log where approval_id = '{apA1}' and org_id = '{orgA}' and actor_id = '{approverA}' and action = 'approve'$q$, '1');
select pg_temp.chk('5 Decide', 'an already-decided approval cannot be decided again', 'authenticated', 'approverA', $q$select status from public.decide_approval('{apA1}', 'reject')$q$, null, 'already decided');
select pg_temp.chk('5 Decide', 'admin can reject', 'authenticated', 'adminA', $q$select status from public.decide_approval('{apA2}', 'reject', 'SECTEST no')$q$, 'rejected');
select pg_temp.chk('5 Decide', 'owner can edit, and the item stays pending', 'authenticated', 'ownerA',
  $q$select title from public.decide_approval('{apA3}', 'edit', 'SECTEST edit', 'SECTEST edited title', null)$q$, 'SECTEST edited title');
select pg_temp.chk('5 Decide', 'edited approval is still pending', null, null, $q$select status from public.approvals where id = '{apA3}'$q$, 'pending');
select pg_temp.chk('5 Decide', 'failed attempts left no audit rows: exactly 3 (approve, reject, edit)', null, null,
  $q$select count(*)::text from public.audit_log where org_id = '{orgA}'$q$, '3');
select pg_temp.chk('5 Decide', 'the B approval was never touched', null, null, $q$select status from public.approvals where id = '{apB}'$q$, 'pending');
select pg_temp.chk('5 Audit', 'a member can read their organisation''s audit log', 'authenticated', 'viewerA', $q$select count(*)::text from public.audit_log where org_id = '{orgA}'$q$, '3');
select pg_temp.chk('5 Audit', 'another organisation cannot read it', 'authenticated', 'ownerB', $q$select count(*)::text from public.audit_log where org_id = '{orgA}'$q$, '0');

-- ---- 6. Append-only history -----------------------------------------------------------------------------------------
select pg_temp.chk('6 Append-only', 'owner cannot update audit_log', 'authenticated', 'ownerA',
  $q$with x as (update public.audit_log set note = 'SECTEST tamper' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('6 Append-only', 'owner cannot delete audit_log', 'authenticated', 'ownerA',
  $q$with x as (delete from public.audit_log returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('6 Append-only', 'owner cannot insert into audit_log directly', 'authenticated', 'ownerA',
  $q$with x as (insert into public.audit_log (org_id, approval_id, action, actor_id) values ('{orgA}', '{apA1}', 'approve', '{ownerA}') returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('6 Append-only', 'even the editor role cannot update audit_log (trigger backstop)', null, null,
  $q$with x as (update public.audit_log set note = 'SECTEST tamper' returning 1) select count(*)::text from x$q$, null, 'append-only');
select pg_temp.chk('6 Append-only', 'even the editor role cannot delete audit_log (trigger backstop)', null, null,
  $q$with x as (delete from public.audit_log returning 1) select count(*)::text from x$q$, null, 'append-only');
select pg_temp.chk('6 Append-only', 'staff can record activity as themselves', 'authenticated', 'staffA',
  $q$with x as (insert into public.agent_activity (org_id, action, actor_id) values ('{orgA}', 'SECTEST did something', '{staffA}') returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('6 Append-only', 'staff cannot record activity as someone else', 'authenticated', 'staffA',
  $q$with x as (insert into public.agent_activity (org_id, action, actor_id) values ('{orgA}', 'SECTEST forged', '{ownerA}') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('6 Append-only', 'viewer cannot record activity', 'authenticated', 'viewerA',
  $q$with x as (insert into public.agent_activity (org_id, action, actor_id) values ('{orgA}', 'SECTEST v', '{viewerA}') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('6 Append-only', 'owner cannot update agent_activity', 'authenticated', 'ownerA',
  $q$with x as (update public.agent_activity set action = 'SECTEST tamper' returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('6 Append-only', 'owner cannot delete agent_activity', 'authenticated', 'ownerA',
  $q$with x as (delete from public.agent_activity returning 1) select count(*)::text from x$q$, null, 'permission denied');
select pg_temp.chk('6 Append-only', 'even the editor role cannot delete agent_activity (trigger backstop)', null, null,
  $q$with x as (delete from public.agent_activity returning 1) select count(*)::text from x$q$, null, 'append-only');
select pg_temp.chk('6 Append-only', 'activity is visible inside its organisation', 'authenticated', 'viewerA', $q$select count(*)::text from public.agent_activity where org_id = '{orgA}'$q$, '1');
select pg_temp.chk('6 Append-only', 'and invisible to another organisation', 'authenticated', 'ownerB', $q$select count(*)::text from public.agent_activity where org_id = '{orgA}'$q$, '0');

-- ---- report (shown just before the rollback) -------------------------------------------------------------------------
select n, section, test, result, expected, actual from (
  select 0 as n, 'SUMMARY'::text as section,
         case when count(*) filter (where not pass) = 0 then 'ALL ' || count(*) || ' CHECKS PASSED'
              else count(*) filter (where not pass) || ' OF ' || count(*) || ' CHECKS FAILED' end as test,
         ''::text as result, ''::text as expected, ''::text as actual
  from sec_results
  union all
  select n, section, test, case when pass then 'PASS' else 'FAIL' end, expected, actual from sec_results
) r order by n;

rollback;
