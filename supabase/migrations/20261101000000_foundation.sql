-- Cheri & Co. — foundation schema with organisation-level Row Level Security.
--
-- STATUS: NOT YET APPLIED to the client's Supabase project. It was executed and tested against a local in-process
-- Postgres (tests/rls.test.ts) but not against Supabase itself. Apply it first with the Supabase CLI or the SQL editor
-- on the client's project (ref ciodkacwdbktuimriuss), review the result, then enable AUTH_MODE=required.
--
-- Tenancy: a user belongs to an organisation through a row in public.memberships (org_id, user_id, role).
-- Every business table carries org_id. Policies compare org_id with the caller's memberships, never with anything
-- the browser sends. Memberships are written only by an administrator (SQL editor or service role), so a user cannot
-- grant themselves access or a higher role.
-- Roles: owner, admin, approver, staff, viewer (mirrors src/lib/auth/roles.ts; keep them in sync).
--   read: any member.  write: owner, admin, approver, staff.  decide approvals: owner, admin, approver.  delete: owner, admin.
--
-- No sample data is inserted here. The demo's sample data stays in the application; a demo organisation, if ever
-- stored, must have organizations.is_demo = true.

-- ---------------------------------------------------------------------------
-- Private helpers (schema is not exposed through the Data API)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 200),
  is_demo    boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  created_at   timestamptz not null default now()
);

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'approver', 'staff', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

-- Helpers are created after the tables they read.
-- SECURITY DEFINER so policies on other tables can read memberships without recursing through its own policies.
create or replace function private.role_in(p_org uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select m.role from public.memberships m where m.org_id = p_org and m.user_id = (select auth.uid())
$$;

create or replace function private.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.role_in(p_org) is not null $$;

create or replace function private.can_write(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.role_in(p_org) in ('owner', 'admin', 'approver', 'staff'), false) $$;

create or replace function private.can_decide(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.role_in(p_org) in ('owner', 'admin', 'approver'), false) $$;

create or replace function private.is_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.role_in(p_org) in ('owner', 'admin'), false) $$;

create or replace function private.shares_org(p_user uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships a
    join public.memberships b on b.org_id = a.org_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  )
$$;

grant execute on function private.role_in(uuid), private.is_member(uuid), private.can_write(uuid),
  private.can_decide(uuid), private.is_admin(uuid), private.shares_org(uuid) to authenticated;

-- A profile row appears automatically when a user is created in Supabase Auth.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Business tables (all carry org_id)
-- ---------------------------------------------------------------------------
create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  instagram  text,
  phone      text,
  email      text,
  city       text,
  interests  text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, id)
);

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  sku        text not null,
  name       text not null check (char_length(name) between 1 and 200),
  category   text,
  price      numeric(10, 2) check (price >= 0),
  stock      integer check (stock >= 0),
  status     text not null default 'draft' check (status in ('draft', 'active', 'low_stock', 'archived')),
  channels   text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, sku),
  unique (org_id, id)
);

create table public.retailers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  business      text not null check (char_length(business) between 1 and 200),
  location      text,
  category      text,
  contact       text,
  email         text,
  phone         text,
  instagram     text,
  website       text,
  qualification text,
  created_at    timestamptz not null default now(),
  unique (org_id, id)
);

-- The B2B pipeline entry for a retailer. The composite FK makes it impossible to point at another tenant's retailer.
create table public.leads (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  retailer_id      uuid not null,
  stage            text not null default 'new'
                   check (stage in ('new', 'qualified', 'contacted', 'interested', 'negotiation', 'won', 'lost')),
  score            integer check (score between 0 and 100),
  temperature      text check (temperature in ('HOT', 'WARM', 'COLD')),
  owner_id         uuid references auth.users (id) on delete set null,
  last_activity_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  foreign key (org_id, retailer_id) references public.retailers (org_id, id) on delete cascade
);

create table public.orders (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid,
  retailer_id uuid,
  channel     text not null check (channel in ('instagram', 'amazon', 'flipkart', 'b2b', 'other')),
  status      text not null default 'new' check (status in ('new', 'paid', 'shipped', 'delivered', 'cancelled', 'returned')),
  total       numeric(12, 2) not null default 0 check (total >= 0),
  line_items  jsonb not null default '[]',
  ordered_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete set null (customer_id),
  foreign key (org_id, retailer_id) references public.retailers (org_id, id) on delete set null (retailer_id)
);

create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  source      text not null default 'Manual',
  due_at      timestamptz,
  priority    text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status      text not null default 'open' check (status in ('open', 'done', 'postponed')),
  assignee_id uuid references auth.users (id) on delete set null,
  related_ref text,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.approvals (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  title        text not null check (char_length(title) <= 200),
  type         text not null,
  generated_by text not null check (generated_by in ('b2c', 'b2b', 'amazon', 'content', 'crm')),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executed')),
  preview      text not null check (char_length(preview) <= 6000),
  meta         jsonb,
  created_at   timestamptz not null default now(),
  unique (org_id, id)
);

-- Content and social calendar. "published" means a person published it outside the app; the app never posts.
create table public.content_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  platform        text not null check (platform in ('Instagram', 'Facebook', 'LinkedIn', 'Pinterest', 'Email', 'Amazon A+')),
  title           text not null check (char_length(title) between 1 and 200),
  topic           text,
  caption         text check (char_length(caption) <= 2200),
  hashtags        text[] not null default '{}',
  creative_brief  text check (char_length(creative_brief) <= 1500),
  image_direction text check (char_length(image_direction) <= 800),
  scheduled_for   date,
  status          text not null default 'draft'
                  check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'published')),
  approval_id     uuid,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete set null (approval_id)
);

-- Append-only record of what each agent or person did.
create table public.agent_activity (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references public.organizations (id) on delete cascade,
  agent      text check (agent in ('b2c', 'b2b', 'amazon', 'content', 'crm')),
  action     text not null check (char_length(action) between 1 and 500),
  ref_type   text,
  ref_id     uuid,
  actor_id   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Append-only record of human decisions. Written only by decide_approval().
create table public.audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organizations (id) on delete cascade,
  approval_id uuid not null,
  action      text not null check (action in ('approve', 'reject', 'edit')),
  actor_id    uuid not null references auth.users (id) on delete restrict,
  note        text check (char_length(note) <= 500),
  at          timestamptz not null default now(),
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete cascade
);

create index on public.memberships (user_id);
create index on public.customers (org_id);
create index on public.retailers (org_id);
create index on public.leads (org_id, stage);
create index on public.orders (org_id, ordered_at desc);
create index on public.tasks (org_id, status);
create index on public.approvals (org_id, status);
create index on public.content_items (org_id, scheduled_for);
create index on public.agent_activity (org_id, created_at desc);
create index on public.audit_log (org_id, approval_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: on for every table, default deny
-- ---------------------------------------------------------------------------
alter table public.organizations  enable row level security;
alter table public.profiles       enable row level security;
alter table public.memberships    enable row level security;
alter table public.customers      enable row level security;
alter table public.products       enable row level security;
alter table public.retailers      enable row level security;
alter table public.leads          enable row level security;
alter table public.orders         enable row level security;
alter table public.tasks          enable row level security;
alter table public.approvals      enable row level security;
alter table public.content_items  enable row level security;
alter table public.agent_activity enable row level security;
alter table public.audit_log      enable row level security;

-- Supabase grants broad default privileges to anon and authenticated. Remove them, then grant only what is used.
-- anon (signed-out visitors) gets nothing at all.
revoke all on public.organizations, public.profiles, public.memberships, public.customers, public.products,
  public.retailers, public.leads, public.orders, public.tasks, public.approvals, public.content_items,
  public.agent_activity, public.audit_log from anon, authenticated;

grant select on public.organizations, public.memberships, public.audit_log to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, insert, update, delete on public.customers, public.products, public.retailers, public.leads,
  public.orders, public.tasks, public.content_items to authenticated;
grant select, insert on public.approvals, public.agent_activity to authenticated;

-- Identity
create policy organizations_read on public.organizations for select to authenticated using (private.is_member(id));
create policy memberships_read   on public.memberships   for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin(org_id));
create policy profiles_read      on public.profiles      for select to authenticated
  using (id = (select auth.uid()) or private.shares_org(id));
create policy profiles_update    on public.profiles      for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Tenant tables: read = member, write = writer role, delete = owner/admin. WITH CHECK stops moving a row to another
-- tenant. org_id is always compared with the caller's memberships, never trusted from the request.
do $$
declare t text;
begin
  foreach t in array array['customers', 'products', 'retailers', 'leads', 'orders', 'tasks', 'content_items'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_member(org_id))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.can_write(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.can_write(org_id)) with check (private.can_write(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_admin(org_id))', t || '_delete', t);
  end loop;
end $$;

-- Approvals: writers may queue a pending item. There is no update or delete policy, so a decision is possible only
-- through decide_approval(). agent_activity and audit_log have no update or delete policy at all.
create policy approvals_read on public.approvals for select to authenticated using (private.is_member(org_id));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (private.can_write(org_id) and status = 'pending');

create policy agent_activity_read on public.agent_activity for select to authenticated using (private.is_member(org_id));
create policy agent_activity_insert on public.agent_activity for insert to authenticated
  with check (private.can_write(org_id) and actor_id is not distinct from (select auth.uid()));

create policy audit_log_read on public.audit_log for select to authenticated using (private.is_member(org_id));

-- ---------------------------------------------------------------------------
-- Decisions: one atomic, role-checked, tenant-checked step that also writes the audit row. The actor is auth.uid(),
-- never a parameter. The content claim guard (src/lib/content-agent/claims.ts) runs in the application before this
-- is called; decide whether to port it into SQL before real content goes live.
-- ---------------------------------------------------------------------------
create or replace function public.decide_approval(
  p_id uuid, p_action text, p_note text default null, p_title text default null, p_preview text default null
) returns public.approvals
language plpgsql security definer set search_path = ''
as $$
declare
  a public.approvals;
begin
  if p_action not in ('approve', 'reject', 'edit') then
    raise exception 'invalid action' using errcode = '22023';
  end if;

  select * into a from public.approvals where id = p_id for update;
  -- Non-members get the same answer as a missing row, so ids in other organisations are not revealed.
  if not found or not private.is_member(a.org_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not private.can_decide(a.org_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if a.status <> 'pending' then
    raise exception 'already decided' using errcode = 'P0001';
  end if;

  update public.approvals set
    status  = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else status end,
    title   = case when p_action = 'edit' then coalesce(p_title, title) else title end,
    preview = case when p_action = 'edit' then coalesce(p_preview, preview) else preview end
  where id = p_id
  returning * into a;

  insert into public.audit_log (org_id, approval_id, action, actor_id, note)
  values (a.org_id, a.id, p_action, (select auth.uid()), p_note);

  return a;
end;
$$;

revoke all on function public.decide_approval(uuid, text, text, text, text) from public, anon;
grant execute on function public.decide_approval(uuid, text, text, text, text) to authenticated;

-- Immutability backstop: audit and activity history cannot be rewritten or deleted, even by mistake.
create or replace function private.append_only() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function private.append_only();
create trigger agent_activity_append_only before update or delete on public.agent_activity
  for each row execute function private.append_only();

-- ---------------------------------------------------------------------------
-- First-time setup (run once as an administrator in the SQL editor; never from the app):
--   insert into public.organizations (name) values ('Cheri & Co.') returning id;
--   -- create the user in Supabase Auth (invite), then:
--   insert into public.memberships (org_id, user_id, role) values ('<org id>', '<auth user id>', 'owner');
-- ---------------------------------------------------------------------------
