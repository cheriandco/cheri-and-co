-- Cheri & Co. -- revoke EXECUTE on public.rls_auto_enable() from everyone except its owner.
--
-- STATUS: NOT APPLIED and NOT TESTED against any database. Saved for review.
--
-- Why: docs/rls_readonly_audit.sql flagged public.rls_auto_enable() ("role anon cannot execute any function"), and
-- docs/rls_function_diagnostic.sql showed it is SECURITY DEFINER, returns event_trigger, and holds EXECUTE for PUBLIC and
-- anon while anon has USAGE on schema public. The function is installed by Supabase's "automatically enable RLS" feature,
-- not by this repository; it is attached to the enabled event trigger ensure_rls and enables row level security on new
-- tables in public. Nobody needs to call it by hand, so nobody except its owner keeps EXECUTE. This matches the foundation
-- migration's rule "anon gets nothing" (compare decide_approval, which is revoked from public and anon).
--
-- CONFIRMED ORIGINAL ACL (before this migration; from the owner's check of the live project):
--   owner:         postgres
--   PUBLIC:        EXECUTE, grantor postgres
--   anon:          EXECUTE, grantor postgres
--   authenticated: EXECUTE, grantor postgres
--   service_role:  EXECUTE, grantor postgres
--   i.e. proacl = {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--   (the entries may be listed in a different order).
--
-- WHY THIS SHOULD NOT DISABLE THE EXISTING EVENT TRIGGER
--   * This migration changes privileges only. It does not drop, replace, disable or alter the function or the event trigger,
--     so the trigger ensure_rls stays enabled and still points at the same function.
--   * Per the PostgreSQL source (src/backend/commands/event_trigger.c), the EXECUTE privilege is not checked when an event
--     trigger fires: the check is made only when the trigger is created (a superuser-only step; the function must return
--     event_trigger), and EventTriggerInvoke calls the function directly (fmgr_info, FunctionCallInvoke) with no
--     pg_proc_aclcheck. So the role running a CREATE TABLE should not need EXECUTE. The function is SECURITY DEFINER, so
--     its body runs with its owner's rights.
--   * THIS BEHAVIOUR HAS NOT BEEN TESTED ON OUR SUPABASE INSTANCE. It is taken from reading the PostgreSQL source. Confirm
--     it with the rolled-back probe in "VERIFY" below before relying on it.
--   * The owner is deliberately not named in the REVOKE, so the owner's EXECUTE is preserved; the block below also checks it.
--
-- REQUIREMENT: RUN THIS AS postgres (the function's owner, and the grantor of every grant being removed). The project owner
-- confirmed in the Supabase SQL Editor that current_user = postgres, session_user = postgres and that postgres owns the
-- function and granted all of its privileges. A REVOKE only removes grants made by the revoking role or by a role it is a
-- member of, so under any other role it could silently do nothing. The block therefore REFUSES to run unless
-- current_user = 'postgres' and the function's owner is postgres, and it RAISES an exception (rolling the whole migration
-- back) if any of the four roles still has EXECUTE afterwards. If the migration is ever run by another tool or role, it
-- fails with a clear message instead of guessing.
--
-- GUARD: if public.rls_auto_enable() does not exist (the feature was never enabled on a project), the block does nothing.
-- IDEMPOTENT: running it again is a no-op once the grants are gone.

do $$
declare
  fn      oid := to_regprocedure('public.rls_auto_enable()');
  fn_owner oid;
  leaked  text[] := '{}';
  r       text;
begin
  if fn is null then
    return;  -- function not present: nothing to harden
  end if;

  select p.proowner into fn_owner from pg_proc p where p.oid = fn;

  -- Explicit guard: the runner must be postgres, and postgres must own the function (and so be the grantor of its grants).
  if current_user::text is distinct from 'postgres' or pg_get_userbyid(fn_owner) is distinct from 'postgres' then
    raise exception 'rls_auto_enable hardening must run as postgres and the function must be owned by postgres; current_user is %, owner is %',
      current_user, pg_get_userbyid(fn_owner);
  end if;

  revoke execute on function public.rls_auto_enable() from public, anon, authenticated, service_role;

  -- Post-revoke verification. PUBLIC is checked in the ACL (it is not a role that has_function_privilege can name).
  if exists (select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
             where p.oid = fn and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    leaked := leaked || 'PUBLIC'::text;
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) and has_function_privilege(r::name, fn, 'EXECUTE') then
      leaked := leaked || r;
    end if;
  end loop;
  if cardinality(leaked) > 0 then
    raise exception 'rls_auto_enable still has EXECUTE for: % (revoke had no effect; check the grantor and the running role)',
      array_to_string(leaked, ', ');
  end if;

  -- The owner's EXECUTE must survive.
  if not has_function_privilege(fn_owner, fn, 'EXECUTE') then
    raise exception 'owner % lost EXECUTE on rls_auto_enable; aborting', pg_get_userbyid(fn_owner);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- READ-ONLY ACL CAPTURE (run before applying, and again after, to compare):
--
--   select p.proacl::text as current_acl, pg_get_userbyid(p.proowner) as owner
--   from pg_proc p where p.oid = to_regprocedure('public.rls_auto_enable()');
--
-- Before: expect the five entries listed under CONFIRMED ORIGINAL ACL. After: expect only postgres=X/postgres.
-- ---------------------------------------------------------------------------------------------------------------------

-- ROLLBACK (not executed by this migration; run by hand only if you must restore the previous grants).
-- Restores all four original grants, each with grantor postgres, and nothing broader.
--
-- REQUIREMENT: run it as postgres (current_user = 'postgres'). A GRANT made by the owner is recorded with the owner
-- (postgres) as grantor, which matches the original ACL. Under any other role it may be recorded differently or refused.
-- The block refuses to run unless current_user = 'postgres' and the function is owned by postgres. Check the result
-- afterwards with the capture query: all five entries above, each "/postgres".
--
--   do $$
--   declare
--     fn       oid := to_regprocedure('public.rls_auto_enable()');
--     fn_owner oid;
--   begin
--     if fn is null then
--       return;
--     end if;
--     select p.proowner into fn_owner from pg_proc p where p.oid = fn;
--     if current_user::text is distinct from 'postgres' or pg_get_userbyid(fn_owner) is distinct from 'postgres' then
--       raise exception 'rollback must run as postgres and the function must be owned by postgres; current_user is %, owner is %',
--         current_user, pg_get_userbyid(fn_owner);
--     end if;
--     grant execute on function public.rls_auto_enable() to public;
--     grant execute on function public.rls_auto_enable() to anon;
--     grant execute on function public.rls_auto_enable() to authenticated;
--     grant execute on function public.rls_auto_enable() to service_role;
--   end
--   $$;

-- VERIFY after applying (read-only, then a transaction that is rolled back):
--
--   1. Run the ACL capture query above. Expect no entry for PUBLIC (an empty grantee before "=") and none for anon,
--      authenticated or service_role; the owner's own entry (postgres=X/postgres) should remain.
--   2. begin;
--      create table public._rls_probe (id int);
--      select relrowsecurity from pg_class where oid = 'public._rls_probe'::regclass;   -- expect true
--      rollback;
--      This is the test that confirms the event trigger still fires with EXECUTE revoked. If it returns false, run the
--      ROLLBACK above and report it.
--   3. Re-run docs/rls_readonly_audit.sql: the public.rls_auto_enable FAIL row should be gone.
