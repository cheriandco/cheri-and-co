-- =====================================================================================================================
-- Cheri & Co. -- READ-ONLY diagnostic for the 9 "role anon cannot execute any function" FAIL rows
--
-- WHERE: Supabase dashboard > project ciodkacwdbktuimriuss > SQL Editor.  HOW: paste this whole file, click Run once.
--
-- READ-ONLY BY CONSTRUCTION: the file is ONE SELECT statement (a WITH query). It changes no permission, function, trigger,
-- policy or setting. It only reads system catalogues (pg_proc, pg_namespace, pg_trigger, pg_event_trigger, pg_default_acl,
-- pg_type) and asks Postgres lookup questions (has_function_privilege, has_schema_privilege, pg_get_functiondef,
-- pg_get_triggerdef). It makes no temporary objects and uses no transaction commands.
--
-- WHAT IT RETURNS: one row per function (a function with several overloads gets one row per signature; a name that does not
-- exist returns one row saying NOT FOUND). Functions inspected:
--   private.append_only, private.can_decide, private.can_write, private.handle_new_user, private.is_admin,
--   private.is_member, private.role_in, private.shares_org, public.rls_auto_enable
--
-- COLUMNS (in order):
--   1  function_signature        schema-qualified name with argument types
--   2  security_definer          true = runs with the owner's rights
--   3  function_type             normal function / trigger function / event trigger function (from the return type)
--   4  attached_to_trigger       table triggers that call it (pg_get_triggerdef), or "none"
--   5  attached_to_event_trigger event triggers that call it, or "none"
--   6  anon_has_execute          what has_function_privilege('anon', ..., 'EXECUTE') answers, INCLUDING anything inherited
--                                from PUBLIC (this is the question the audit asked)
--   7  anon_execute_source       WHY it is true: explicit grant to anon, inherited from PUBLIC, or another role
--   8  anon_has_schema_usage     whether anon has USAGE on the function's schema (without USAGE a role cannot reach any
--                                object in that schema, whatever the function's own grant says)
--   9  anon_effective_reach      EXECUTE and schema USAGE both true = anon can call it by name (the real exposure)
--  10  public_has_execute        PUBLIC (everyone) holds EXECUTE: true when the ACL is empty (built-in default) or lists PUBLIC
--  11  explicit_acl              the function's stored ACL (proacl). NULL here means "never changed from the default",
--                                and the default gives EXECUTE to PUBLIC and the owner
--  12  acl_entries_expanded      the same ACL spelled out one privilege per entry, with grantor
--  13  default_acl_for_owner     default-privilege rules (pg_default_acl, functions) for the owner in this schema or all
--                                schemas. These affect only functions created AFTER the rule, so they explain how a
--                                function came to hold a grant, they do not change existing ones
--  14  schema_owner / 15 schema_acl   the schema's owner and its ACL (USAGE and CREATE grants)
--  16  function_owner / language / volatility / pinned_config (search_path and other function settings)
--  17  definition               full text from pg_get_functiondef()
--
-- HOW TO READ THE RESULT (guidance, not a verdict):
--   * anon_has_execute = true with public_has_execute = true and explicit_acl NULL: the function simply kept the Postgres
--     default (EXECUTE to PUBLIC). The audit flags that. Whether it is exploitable depends on column 8 and the type.
--   * anon_has_schema_usage = false for the private schema means anon cannot reach those functions by name even though
--     EXECUTE is inherited. Verify this in column 8 rather than assume it.
--   * Trigger and event trigger functions are not meant to be called by hand. Check the function_type and the attached
--     triggers, and read the definition, before deciding what, if anything, to change.
--   * public.rls_auto_enable lives in schema public, which anon normally CAN use, so look at columns 8 and 9 for it first.
--
-- LIMITS: this shows grants and definitions as they are right now. It cannot show whether the Data API actually lists a
-- function as callable (check Project Settings > API > Exposed schemas, and test the endpoint separately). Nothing here
-- proposes or applies a fix.
-- =====================================================================================================================

with
wanted(sch, fname) as (
  values ('private', 'append_only'),
         ('private', 'can_decide'),
         ('private', 'can_write'),
         ('private', 'handle_new_user'),
         ('private', 'is_admin'),
         ('private', 'is_member'),
         ('private', 'role_in'),
         ('private', 'shares_org'),
         ('public',  'rls_auto_enable')
),
-- The anon role (null when it does not exist, for example outside a Supabase project).
anon as (
  select (select r.oid from pg_roles r where r.rolname = 'anon') as anon_oid
),
-- One row per wanted name and overload; a missing function or schema keeps a row with null catalogue columns.
f as (
  select w.sch, w.fname,
         n.oid as sch_oid, n.nspname, n.nspowner, n.nspacl,
         p.oid as fn_oid, p.proname, p.prosecdef, p.prokind, p.proowner, p.proacl, p.proconfig, p.provolatile,
         p.prolang, p.prorettype
  from wanted w
  left join pg_namespace n on n.nspname = w.sch
  left join pg_proc p on p.pronamespace = n.oid and p.proname = w.fname
)
select
  -- 1 signature
  case when f.fn_oid is null then f.sch || '.' || f.fname || '  -- NOT FOUND'
       else f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.fn_oid) || ')' end as function_signature,
  -- 2 security definer
  f.prosecdef as security_definer,
  -- 3 function type, from the return type
  case when f.fn_oid is null then null
       when t.typname = 'trigger' then 'trigger function'
       when t.typname = 'event_trigger' then 'event trigger function'
       else 'normal function (returns ' || format_type(f.prorettype, null) || ')' end as function_type,
  -- 4 attached to a table trigger
  case when f.fn_oid is null then null
       else coalesce((select string_agg(pg_get_triggerdef(tg.oid) || '  [enabled flag: ' || tg.tgenabled::text || ']', ' | ' order by tg.tgname)
                      from pg_trigger tg
                      where tg.tgfoid = f.fn_oid and not tg.tgisinternal), 'none') end as attached_to_trigger,
  -- 5 attached to an event trigger
  case when f.fn_oid is null then null
       else coalesce((select string_agg(et.evtname || ' (fires on ' || et.evtevent || ', enabled flag: ' || et.evtenabled::text || ')', ' | ' order by et.evtname)
                      from pg_event_trigger et
                      where et.evtfoid = f.fn_oid), 'none') end as attached_to_event_trigger,
  -- 6 anon EXECUTE (inheritance through PUBLIC included)
  case when f.fn_oid is null or a.anon_oid is null then null
       else has_function_privilege('anon', f.fn_oid, 'EXECUTE') end as anon_has_execute,
  -- 7 why
  case when f.fn_oid is null or a.anon_oid is null then null
       when not has_function_privilege('anon', f.fn_oid, 'EXECUTE') then 'anon has no EXECUTE'
       when exists (select 1 from aclexplode(f.proacl) x where x.grantee = a.anon_oid and x.privilege_type = 'EXECUTE')
         then 'explicit grant to anon'
       when f.proacl is null or exists (select 1 from aclexplode(f.proacl) x where x.grantee = 0 and x.privilege_type = 'EXECUTE')
         then 'inherited from PUBLIC (no explicit grant to anon)'
       else 'inherited through another role that anon is a member of' end as anon_execute_source,
  -- 8 schema usage
  case when f.sch_oid is null or a.anon_oid is null then null
       else has_schema_privilege('anon', f.sch_oid, 'USAGE') end as anon_has_schema_usage,
  -- 9 effective reach
  case when f.fn_oid is null or a.anon_oid is null then null
       else has_function_privilege('anon', f.fn_oid, 'EXECUTE') and has_schema_privilege('anon', f.sch_oid, 'USAGE') end as anon_effective_reach,
  -- 10 PUBLIC EXECUTE
  case when f.fn_oid is null then null
       else (f.proacl is null or exists (select 1 from aclexplode(f.proacl) x where x.grantee = 0 and x.privilege_type = 'EXECUTE')) end as public_has_execute,
  -- 11 stored ACL
  case when f.fn_oid is null then null
       else coalesce(f.proacl::text, 'NULL (default: EXECUTE for PUBLIC and the owner)') end as explicit_acl,
  -- 12 ACL expanded
  case when f.fn_oid is null then null
       else coalesce((select string_agg(case x.grantee when 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end
                                        || ' ' || x.privilege_type
                                        || case when x.is_grantable then ' (grantable)' else '' end
                                        || ' granted by ' || pg_get_userbyid(x.grantor), E'\n' order by x.grantee, x.privilege_type)
                      from aclexplode(f.proacl) x), 'no stored ACL: default applies') end as acl_entries_expanded,
  -- 13 default privilege rules for functions
  case when f.fn_oid is null then null
       else coalesce((select string_agg('role ' || pg_get_userbyid(d.defaclrole) || ' in '
                                        || case when d.defaclnamespace = 0::oid then 'all schemas' else d.defaclnamespace::regnamespace::text end
                                        || ': ' || d.defaclacl::text, E'\n' order by d.oid)
                      from pg_default_acl d
                      where d.defaclobjtype = 'f'
                        and d.defaclrole = f.proowner
                        and (d.defaclnamespace = 0::oid or d.defaclnamespace = f.sch_oid)), 'none') end as default_acl_for_owner,
  -- 14, 15 schema owner and ACL
  case when f.sch_oid is null then 'schema ' || f.sch || ' NOT FOUND' else pg_get_userbyid(f.nspowner) end as schema_owner,
  case when f.sch_oid is null then null else coalesce(f.nspacl::text, 'NULL (owner only)') end as schema_acl,
  -- 16 owner and settings
  case when f.fn_oid is null then null else pg_get_userbyid(f.proowner) end as function_owner,
  case when f.fn_oid is null then null else (select l.lanname::text from pg_language l where l.oid = f.prolang) end as language,
  case when f.fn_oid is null then null
       else case f.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end end as volatility,
  case when f.fn_oid is null then null else coalesce(array_to_string(f.proconfig, ', '), 'none') end as pinned_config,
  -- 17 full definition
  case when f.fn_oid is null then null
       when f.prokind in ('f', 'p') then pg_get_functiondef(f.fn_oid)
       else '(not a plain function or procedure; definition not available)' end as definition
from f
cross join anon a
left join pg_type t on t.oid = f.prorettype
order by f.sch, f.fname, f.fn_oid;
