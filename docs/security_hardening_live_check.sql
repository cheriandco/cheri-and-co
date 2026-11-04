-- =====================================================================================================================
-- Cheri & Co. — LIVE database check for 20261104000000_security_hardening.sql (claims guard + locked content)
--
-- STATUS: PREPARED, NOT YET RUN ON ANY SUPABASE PROJECT. The same script is executed against an in-process Postgres by
-- tests/security-hardening-script.test.ts, which proves the script itself is sound; that is NOT hosted verification.
--
-- WHERE: the STAGING project's SQL Editor ONLY (see docs/STAGING_SETUP_AND_VERIFICATION.md). Never production.
-- PRECONDITION: 20261101000000_foundation.sql AND 20261104000000_security_hardening.sql are both applied.
-- HOW: paste this WHOLE file and click Run ONCE. Same safety model as docs/rls_live_check.sql:
--  * One transaction (BEGIN ... ROLLBACK): nothing is kept. Fixtures are fake (@cheri-security-test.invalid, names start SECTEST).
--  * No service-role key, no policy or Auth settings changed, no real users or data touched.
--  * Each check switches to the database role the app uses (authenticated / anon) and sets the JWT subject, so policies,
--    triggers and the SECURITY DEFINER functions behave as they do for a real signed-in user.
-- OUTPUT: a table with a SUMMARY row on top, then PASS/FAIL per check. If a run stops with an error, run  ROLLBACK;  on its own.
-- =====================================================================================================================

begin;

create temp table fx (k text primary key, id uuid not null);
create temp table sec_results (n serial, section text, test text, expected text, actual text, pass boolean);

insert into fx (k, id) values
  ('orgA',     'aaaaaaaa-0000-4000-8000-00000000000a'), ('orgB',     'bbbbbbbb-0000-4000-8000-00000000000b'),
  ('ownerA',   'a1000000-0000-4000-8000-000000000001'), ('adminA',   'a1000000-0000-4000-8000-000000000002'),
  ('approverA','a1000000-0000-4000-8000-000000000003'), ('staffA',   'a1000000-0000-4000-8000-000000000004'),
  ('viewerA',  'a1000000-0000-4000-8000-000000000005'), ('ownerB',   'b1000000-0000-4000-8000-000000000001'),
  ('loner',    'c1000000-0000-4000-8000-000000000001'),
  ('pClean',   'a6000000-0000-4000-8000-000000000001'), ('pBad',     'a6000000-0000-4000-8000-000000000002'),
  ('pLock',    'a6000000-0000-4000-8000-000000000003'), ('pForged',  'a6000000-0000-4000-8000-000000000004'),
  ('pDraft',   'a6000000-0000-4000-8000-000000000005'), ('pNoCap',   'a6000000-0000-4000-8000-000000000006'),
  ('pReopen',  'a6000000-0000-4000-8000-000000000007'), ('pRej',     'a6000000-0000-4000-8000-000000000008'),
  ('pMeta',    'a6000000-0000-4000-8000-000000000009'), ('pOther',   'a6000000-0000-4000-8000-00000000000a'),
  ('pFlow',    'a6000000-0000-4000-8000-00000000000b'),
  ('apBad',    'a7000000-0000-4000-8000-000000000001'), ('apCase',   'a7000000-0000-4000-8000-000000000002'),
  ('apForged', 'a7000000-0000-4000-8000-000000000003'), ('apMeta',   'a7000000-0000-4000-8000-000000000004'),
  ('apRej',    'a7000000-0000-4000-8000-000000000005'), ('apB2c',    'a7000000-0000-4000-8000-000000000006'),
  ('pStr',     'a6000000-0000-4000-8000-00000000000c'), ('apStr',    'a7000000-0000-4000-8000-000000000007'),
  ('pTitle',   'a6000000-0000-4000-8000-00000000000d'), ('pLong',    'a6000000-0000-4000-8000-00000000000e'),
  ('apTitle',  'a7000000-0000-4000-8000-000000000008');

-- chk(): same contract as docs/rls_live_check.sql. p_err NULL -> must succeed and return p_expect; else must fail matching p_err.
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

-- ---- fixtures -------------------------------------------------------------------------------------------------------
insert into auth.users (id, email)
  select id, k || '@cheri-security-test.invalid' from fx where k in ('ownerA','adminA','approverA','staffA','viewerA','ownerB','loner');
insert into public.organizations (id, name) select id, 'SECTEST ' || k from fx where k in ('orgA','orgB');
insert into public.memberships (org_id, user_id, role)
  select (select id from fx where k = o), (select id from fx where k = u), r
  from (values ('orgA','ownerA','owner'), ('orgA','adminA','admin'), ('orgA','approverA','approver'),
               ('orgA','staffA','staff'), ('orgA','viewerA','viewer'), ('orgB','ownerB','owner')) as m (o, u, r);

-- Posts are created as the editor's own role (bypasses RLS and the API-only triggers, which is how seeded data looks).
insert into public.content_items (id, org_id, platform, title, caption, status)
  select (select id from fx where k = p), (select id from fx where k = 'orgA'), 'Instagram', 'SECTEST ' || p, c, s
  from (values ('pClean','A calm look for spring','draft'), ('pBad','Real gold, only 499 rupees','draft'), ('pLock','Locked words','pending_approval'),
               ('pForged','Forged allowlist','pending_approval'), ('pDraft','Editable draft','draft'), ('pNoCap',null,'draft'),
               ('pReopen','Will be rejected','pending_approval'), ('pRej','Already rejected','rejected'), ('pMeta','Meta mismatch','pending_approval'),
               ('pFlow','Flow post','draft')) as v (p, c, s);
insert into public.content_items (id, org_id, platform, title, caption)
  values ((select id from fx where k='pOther'), (select id from fx where k='orgB'), 'Instagram', 'SECTEST other org', 'Other org post');

-- Approvals as the OLD client flow created them (plus forged variants), linked to their posts by the editor role.
insert into public.approvals (id, org_id, title, type, generated_by, preview, meta)
  select (select id from fx where k = a), (select id from fx where k='orgA'), 'SECTEST ' || a, t, g, pv, m::jsonb
  from (values ('apBad','Content','content','Caption: Only ₹499, waterproof', '{"kind":"content_draft"}'),
               ('apCase','Content','content','Caption: ANTI-TARNISH and WATERPROOF', '{"kind":"content_draft"}'),
               ('apForged','Content','content','Caption: waterproof and anti-tarnish', '{"kind":"content_draft","allowedClaims":["waterproof","anti-tarnish"]}'),
               ('apMeta','Content','content','Caption: calm', null),
               ('apRej','Content','content','Caption: calm', null),
               ('apB2c','B2C reply','b2c','The bracelet is ₹499, 50% off, waterproof', '{"kind":"b2c_reply"}')) as v (a, t, g, pv, m);
update public.content_items set approval_id = (select id from fx where k='apBad')    where id = (select id from fx where k='pLock');
update public.content_items set approval_id = (select id from fx where k='apForged') where id = (select id from fx where k='pForged');
update public.content_items set approval_id = (select id from fx where k='apRej')    where id = (select id from fx where k='pReopen');
-- a mismatched meta.postId: the approval says it belongs to pDraft but is linked to pMeta
update public.approvals set meta = jsonb_build_object('kind','content_draft','postId',(select id from fx where k='pDraft'))
  where id = (select id from fx where k='apMeta');
update public.content_items set approval_id = (select id from fx where k='apMeta') where id = (select id from fx where k='pMeta');
-- apCase is linked to nothing on purpose: it checks the type/generator condition without a post.

-- Fixtures for section 5 (review fixes). pStr is a stranded link: a draft whose approval is still pending.
insert into public.content_items (id, org_id, platform, title, caption, status)
  values ((select id from fx where k='pStr'),   (select id from fx where k='orgA'), 'Instagram', 'SECTEST stranded', 'Calm words', 'draft'),
         ((select id from fx where k='pTitle'), (select id from fx where k='orgA'), 'Instagram', '100% guaranteed waterproof', 'Calm words', 'draft');
insert into public.content_items (id, org_id, platform, title, caption, hashtags)
  values ((select id from fx where k='pLong'), (select id from fx where k='orgA'), 'Instagram', 'SECTEST long', 'Calm words',
          (select array_agg('#tag' || g || repeat('x', 40)) from generate_series(1, 200) g));
insert into public.approvals (id, org_id, title, type, generated_by, preview)
  values ((select id from fx where k='apStr'),   (select id from fx where k='orgA'), 'SECTEST stranded', 'Content', 'content', 'Caption: calm'),
         ((select id from fx where k='apTitle'), (select id from fx where k='orgA'), 'Real gold sale',   'Content', 'content', 'Caption: calm');
update public.content_items set approval_id = (select id from fx where k='apStr') where id = (select id from fx where k='pStr');

-- ---- 0. Structure ---------------------------------------------------------------------------------------------------
select pg_temp.chk('0 Structure', 'the three controlled functions exist, are SECURITY DEFINER and fix their search_path', null, null,
  $q$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('submit_content','reopen_content','decide_approval') and p.prosecdef
       and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')$q$, '3');
select pg_temp.chk('0 Structure', 'visitors (anon) cannot execute any of them', null, null,
  $q$select (has_function_privilege('anon','public.submit_content(uuid)','execute') or has_function_privilege('anon','public.reopen_content(uuid)','execute')
     or has_function_privilege('anon','public.decide_approval(uuid,text,text,text,text)','execute'))::text$q$, 'false');
select pg_temp.chk('0 Structure', 'signed-in users can execute them', null, null,
  $q$select (has_function_privilege('authenticated','public.submit_content(uuid)','execute') and has_function_privilege('authenticated','public.reopen_content(uuid)','execute')
     and has_function_privilege('authenticated','public.decide_approval(uuid,text,text,text,text)','execute'))::text$q$, 'true');
select pg_temp.chk('0 Structure', 'the claim helper is not executable by signed-in users', null, null,
  $q$select has_function_privilege('authenticated','private.find_prohibited_claims(text)','execute')::text$q$, 'false');
select pg_temp.chk('0 Structure', 'the two guard triggers exist', null, null,
  $q$select count(*)::text from pg_trigger where tgname in ('content_items_guard','approvals_meta_guard') and not tgisinternal$q$, '2');

-- ---- 1. Prohibited claims -------------------------------------------------------------------------------------------
select pg_temp.chk('1 Claims', 'staff can submit a clean draft', 'authenticated', 'staffA', $q$select (public.submit_content('{pClean}') is not null)::text$q$, 'true');
select pg_temp.chk('1 Claims', 'the submitted post is pending and linked to a pending approval whose meta.postId is the post', null, null,
  $q$select (c.status = 'pending_approval' and a.status = 'pending' and a.meta ->> 'postId' = c.id::text and a.type = 'Content')::text
     from public.content_items c join public.approvals a on a.id = c.approval_id where c.id = '{pClean}'$q$, 'true');
select pg_temp.chk('1 Claims', 'submitting wording with a price/material claim is refused by the database', 'authenticated', 'staffA',
  $q$select public.submit_content('{pBad}')::text$q$, null, 'prohibited claims');
select pg_temp.chk('1 Claims', '...and the refused post is still an untouched draft', null, null,
  $q$select (status = 'draft' and approval_id is null)::text from public.content_items where id = '{pBad}'$q$, 'true');
select pg_temp.chk('1 Claims', 'a direct decide_approval call cannot approve prohibited wording', 'authenticated', 'approverA',
  $q$select status from public.decide_approval('{apBad}', 'approve')$q$, null, 'prohibited claims');
select pg_temp.chk('1 Claims', '...case variations (ANTI-TARNISH, WATERPROOF) are caught too', 'authenticated', 'ownerA',
  $q$select status from public.decide_approval('{apCase}', 'approve')$q$, null, 'prohibited claims');
select pg_temp.chk('1 Claims', 'a forged allowedClaims list does not unlock anything', 'authenticated', 'adminA',
  $q$select status from public.decide_approval('{apForged}', 'approve')$q$, null, 'prohibited claims');
select pg_temp.chk('1 Claims', 'staff cannot plant allowedClaims / postId / kind=content_draft in an approval', 'authenticated', 'staffA',
  $q$with x as (insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('{orgA}', 'SECTEST forge', 'Content', 'content', 'p', '{"allowedClaims":["waterproof"]}') returning 1) select count(*)::text from x$q$, null, 'set only by the approval workflow');
select pg_temp.chk('1 Claims', 'a refused approval stays pending (nothing changed)', null, null, $q$select status from public.approvals where id = '{apBad}'$q$, 'pending');
select pg_temp.chk('1 Claims', 'a refused decision wrote no audit row', null, null, $q$select count(*)::text from public.audit_log where approval_id in ('{apBad}','{apCase}','{apForged}')$q$, '0');
select pg_temp.chk('1 Claims', 'non-content approvals are not blocked by the claim rules', 'authenticated', 'approverA',
  $q$select status from public.decide_approval('{apB2c}', 'approve')$q$, 'approved');
select pg_temp.chk('1 Claims', 'a clean content approval is approved and its post follows in the same step', 'authenticated', 'approverA',
  $q$select status from public.decide_approval((select approval_id from public.content_items where id = '{pClean}'), 'approve', 'ok')$q$, 'approved');
select pg_temp.chk('1 Claims', '...the post is now approved', null, null, $q$select status from public.content_items where id = '{pClean}'$q$, 'approved');
select pg_temp.chk('1 Claims', '...and the audit row names the real approver', null, null,
  $q$select count(*)::text from public.audit_log where approval_id = (select approval_id from public.content_items where id = '{pClean}') and actor_id = '{approverA}' and action = 'approve'$q$, '1');

-- ---- 2. Content is locked around the workflow -----------------------------------------------------------------------
select pg_temp.chk('2 Locked content', 'staff cannot set a post to approved directly', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set status = 'approved' where id = '{pDraft}' returning 1) select count(*)::text from x$q$, null, 'only through submit_content');
select pg_temp.chk('2 Locked content', 'staff cannot point a post at an existing approved approval', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set approval_id = (select approval_id from public.content_items where id = '{pClean}') where id = '{pDraft}' returning 1) select count(*)::text from x$q$, null, 'only through submit_content');
select pg_temp.chk('2 Locked content', 'staff cannot insert a post that is already approved', 'authenticated', 'staffA',
  $q$with x as (insert into public.content_items (org_id, platform, title, status) values ('{orgA}', 'Instagram', 'SECTEST sneaky', 'approved') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('2 Locked content', 'the wording of a pending post cannot be changed (staff)', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set caption = 'Real gold, only 1 rupees' where id = '{pLock}' returning 1) select count(*)::text from x$q$, null, 'locked while it is pending');
select pg_temp.chk('2 Locked content', 'the wording of an approved post cannot be changed (staff)', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set caption = 'changed' where id = '{pClean}' returning 1) select count(*)::text from x$q$, null, 'locked while it is pending');
select pg_temp.chk('2 Locked content', 'the wording of an approved post cannot be changed (owner either)', 'authenticated', 'ownerA',
  $q$with x as (update public.content_items set title = 'changed' where id = '{pClean}' returning 1) select count(*)::text from x$q$, null, 'locked while it is pending');
select pg_temp.chk('2 Locked content', 'a draft can still be edited by staff', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set caption = 'New draft words' where id = '{pDraft}' returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('2 Locked content', 'the planned date of a locked post can still be moved', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set scheduled_for = '2030-01-01' where id = '{pClean}' returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('2 Locked content', 'a viewer cannot edit a draft', 'authenticated', 'viewerA',
  $q$with x as (update public.content_items set caption = 'viewer edit' where id = '{pDraft}' returning 1) select count(*)::text from x$q$, '0');
select pg_temp.chk('2 Locked content', 'another organisation cannot edit this draft', 'authenticated', 'ownerB',
  $q$with x as (update public.content_items set caption = 'cross org' where id = '{pDraft}' returning 1) select count(*)::text from x$q$, '0');

-- ---- 3. Roles and isolation on the controlled functions -------------------------------------------------------------
select pg_temp.chk('3 Functions', 'a viewer cannot submit', 'authenticated', 'viewerA', $q$select public.submit_content('{pDraft}')::text$q$, null, 'not authorized');
select pg_temp.chk('3 Functions', 'another organisation cannot see or submit the post', 'authenticated', 'ownerB', $q$select public.submit_content('{pDraft}')::text$q$, null, 'not found');
select pg_temp.chk('3 Functions', 'a visitor cannot call submit_content', 'anon', null, $q$select public.submit_content('{pDraft}')::text$q$, null, 'permission denied');
select pg_temp.chk('3 Functions', 'a draft with no caption cannot be submitted', 'authenticated', 'staffA', $q$select public.submit_content('{pNoCap}')::text$q$, null, 'caption is required');
select pg_temp.chk('3 Functions', 'a pending post cannot be submitted again', 'authenticated', 'staffA', $q$select public.submit_content('{pLock}')::text$q$, null, 'only drafts');
select pg_temp.chk('3 Functions', 'staff cannot decide', 'authenticated', 'staffA',
  $q$select status from public.decide_approval((select approval_id from public.content_items where id = '{pForged}'), 'reject')$q$, null, 'not authorized');
select pg_temp.chk('3 Functions', 'another organisation cannot decide', 'authenticated', 'ownerB',
  $q$select status from public.decide_approval((select approval_id from public.content_items where id = '{pForged}'), 'reject')$q$, null, 'not found');
select pg_temp.chk('3 Functions', 'an approval whose meta.postId names another post is refused', 'authenticated', 'approverA',
  $q$select status from public.decide_approval('{apMeta}', 'approve')$q$, null, 'does not match its post');
select pg_temp.chk('3 Functions', '...and stays pending', null, null, $q$select status from public.approvals where id = '{apMeta}'$q$, 'pending');

-- ---- 4. Reopen and resubmit -----------------------------------------------------------------------------------------
select pg_temp.chk('4 Reopen', 'a post waiting for a decision cannot be reopened', 'authenticated', 'staffA', $q$select public.reopen_content('{pLock}')::text$q$, null, 'waiting for a decision');
select pg_temp.chk('4 Reopen', 'a rejected post is reopened by staff', 'authenticated', 'staffA', $q$select 'ok' from (select public.reopen_content('{pRej}')) s$q$, 'ok');
select pg_temp.chk('4 Reopen', '...it is a draft again with no approval link', null, null, $q$select (status = 'draft' and approval_id is null)::text from public.content_items where id = '{pRej}'$q$, 'true');
select pg_temp.chk('4 Reopen', '...and the reopening is in the activity log under the staff member', null, null,
  $q$select count(*)::text from public.agent_activity where ref_id = '{pRej}' and actor_id = '{staffA}' and action like 'Reopened%'$q$, '1');
select pg_temp.chk('4 Reopen', 'staff cannot reopen an approved post', 'authenticated', 'staffA', $q$select public.reopen_content('{pClean}')::text$q$, null, 'not authorized');
select pg_temp.chk('4 Reopen', 'an approver can withdraw an approved post (it then needs a new approval)', 'authenticated', 'approverA', $q$select 'ok' from (select public.reopen_content('{pClean}')) s$q$, 'ok');
select pg_temp.chk('4 Reopen', 'the full flow: reject, reopen, edit, resubmit gives a NEW pending approval',  'authenticated', 'staffA',
  $q$select (public.submit_content('{pFlow}') is not null)::text$q$, 'true');
select pg_temp.chk('4 Reopen', '...rejected by an approver', 'authenticated', 'approverA',
  $q$select status from public.decide_approval((select approval_id from public.content_items where id = '{pFlow}'), 'reject', 'reword')$q$, 'rejected');
select pg_temp.chk('4 Reopen', '...reopened, edited and resubmitted', 'authenticated', 'staffA',
  $q$select 'ok' from (select public.reopen_content('{pFlow}')) s$q$, 'ok');
select pg_temp.chk('4 Reopen', '...edit while a draft', 'authenticated', 'staffA',
  $q$with x as (update public.content_items set caption = 'A softer caption' where id = '{pFlow}' returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('4 Reopen', '...resubmitted', 'authenticated', 'staffA',
  $q$select 'ok' from (select public.submit_content('{pFlow}')) s$q$, 'ok');
select pg_temp.chk('4 Reopen', '...the new approval carries the new text', null, null,
  $q$select (a.preview like '%A softer caption%' and a.status = 'pending')::text from public.approvals a join public.content_items c on c.approval_id = a.id where c.id = '{pFlow}'$q$, 'true');
select pg_temp.chk('4 Reopen', '...and the old rejected approval is still there as history', null, null,
  $q$select count(*)::text from public.approvals where meta ->> 'postId' = '{pFlow}' and status = 'rejected'$q$, '1');

-- ---- 5. Review fixes: look-alikes (F1), stranded approvals (F3), no edits to a post's approval (F4), forged history (F5),
--         titles and topics (F6), over-long posts (F12) ---------------------------------------------------------------------
select pg_temp.chk('5 Look-alikes', 'the normaliser is not executable by signed-in users', null, null,
  $q$select has_function_privilege('authenticated','private.normalize_claim_text(text)','execute')::text$q$, 'false');
select pg_temp.chk('5 Look-alikes', 'a no-break space inside a price is caught', null, null,
  $q$select (cardinality(private.find_prohibited_claims('Only ₹' || chr(160) || '499')) > 0)::text$q$, 'true');
select pg_temp.chk('5 Look-alikes', 'a zero-width space inside a claim is caught', null, null,
  $q$select (cardinality(private.find_prohibited_claims('water' || chr(8203) || 'proof')) > 0)::text$q$, 'true');
select pg_temp.chk('5 Look-alikes', 'a non-breaking hyphen and an en dash are caught', null, null,
  $q$select (cardinality(private.find_prohibited_claims('water' || chr(8209) || 'proof and anti' || chr(8211) || 'tarnish')) = 2)::text$q$, 'true');
select pg_temp.chk('5 Look-alikes', 'a Cyrillic letter standing in for a Latin one is caught', null, null,
  $q$select (cardinality(private.find_prohibited_claims('gu' || chr(1072) || 'rantee')) > 0)::text$q$, 'true');
select pg_temp.chk('5 Look-alikes', 'a fullwidth percent sign is caught', null, null,
  $q$select (cardinality(private.find_prohibited_claims('50' || chr(65285) || ' off')) > 0)::text$q$, 'true');
select pg_temp.chk('5 Look-alikes', 'a line break inside a phrase is caught', null, null,
  $q$select (cardinality(private.find_prohibited_claims('only' || chr(10) || '5 left')) > 0)::text$q$, 'true');
select pg_temp.chk('5 Look-alikes', 'ordinary copy in other scripts raises no alarm', null, null,
  $q$select cardinality(private.find_prohibited_claims('सुंदर गहने, café, naïve façade'))::text$q$, '0');
select pg_temp.chk('5 Look-alikes', 'submit_content refuses a post that hides a claim behind a zero-width space', 'authenticated', 'staffA',
  $q$with p as (insert into public.content_items (org_id, platform, title, caption) values ('{orgA}', 'Instagram', 'SECTEST hidden', 'water' || chr(8203) || 'proof bracelet') returning id)
     select public.submit_content((select id from p))::text$q$, null, 'prohibited claims');

select pg_temp.chk('5 Stranded', 'a post that is not waiting cannot have its approval approved', 'authenticated', 'approverA',
  $q$select status from public.decide_approval('{apStr}', 'approve')$q$, null, 'not waiting for approval');
select pg_temp.chk('5 Stranded', '...but the approval can be rejected to clear the queue', 'authenticated', 'approverA',
  $q$select status from public.decide_approval('{apStr}', 'reject', 'stale')$q$, 'rejected');
select pg_temp.chk('5 Stranded', '...and the post itself is left alone', null, null,
  $q$select status from public.content_items where id = '{pStr}'$q$, 'draft');
select pg_temp.chk('5 Stranded', 'staff still cannot decide', 'authenticated', 'staffA',
  $q$select status from public.decide_approval((select approval_id from public.content_items where id = '{pFlow}'), 'reject')$q$, null, 'not authorized');

select pg_temp.chk('5 No edits', 'the approval of a post cannot be edited', 'authenticated', 'approverA',
  $q$select preview from public.decide_approval((select approval_id from public.content_items where id = '{pFlow}'), 'edit', null, null, 'Totally different caption')$q$, null, 'cannot be edited');
select pg_temp.chk('5 No edits', '...so the approved text is still the post as submitted', null, null,
  $q$select (a.preview like '%A softer caption%')::text from public.approvals a join public.content_items c on c.approval_id = a.id where c.id = '{pFlow}'$q$, 'true');

select pg_temp.chk('5 History', 'staff cannot write activity that points at a post', 'authenticated', 'staffA',
  $q$with x as (insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id) values ('{orgA}', 'content', 'Reopened "x" for editing', 'content_item', '{pFlow}', '{staffA}') returning 1) select count(*)::text from x$q$, null, 'row-level security');
select pg_temp.chk('5 History', 'ordinary activity (no reference) still works', 'authenticated', 'staffA',
  $q$with x as (insert into public.agent_activity (org_id, agent, action, actor_id) values ('{orgA}', 'crm', 'SECTEST ordinary', '{staffA}') returning 1) select count(*)::text from x$q$, '1');
select pg_temp.chk('5 History', 'withdrawing an approved post is recorded as such, under the approver', null, null,
  $q$select count(*)::text from public.agent_activity where ref_id = '{pClean}' and actor_id = '{approverA}' and action like 'Reopened%had been approved%'$q$, '1');

select pg_temp.chk('5 Titles', 'a claim in the title stops submission', 'authenticated', 'staffA',
  $q$select public.submit_content('{pTitle}')::text$q$, null, 'prohibited claims');
select pg_temp.chk('5 Titles', 'a claim in an approval title stops approval', 'authenticated', 'approverA',
  $q$select status from public.decide_approval('{apTitle}', 'approve')$q$, null, 'prohibited claims');

select pg_temp.chk('5 Length', 'a post too long for the approval queue gets a plain refusal', 'authenticated', 'staffA',
  $q$select public.submit_content('{pLong}')::text$q$, null, 'too long to send for approval');
select pg_temp.chk('5 Length', '...and stays an untouched draft', null, null,
  $q$select (status = 'draft' and approval_id is null)::text from public.content_items where id = '{pLong}'$q$, 'true');

-- ---- report -----------------------------------------------------------------------------------------------------------
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
