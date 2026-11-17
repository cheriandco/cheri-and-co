-- Amazon Intelligence (M5). Forward-only. NOT APPLIED anywhere. Apply to a staging project first (docs/M5_SCHEMA_PROPOSAL.md, docs/M5_AMAZON_INTELLIGENCE.md).
-- Generated from the draft SQL in docs/M5_SCHEMA_PROPOSAL.md section 3; tests/m5-schema-draft.test.ts fails if the two ever differ.
-- Depends on the foundation migration (organizations, approvals, private.is_member / is_admin / can_write).
-- Eight tables, all carrying org_id and environment. Read-only toward Amazon: nothing here stores buyer data, credentials or raw API payloads.

-- ---------------------------------------------------------------------------
-- amazon_connections
-- ---------------------------------------------------------------------------
create table public.amazon_connections (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  environment         text not null check (environment in ('sandbox', 'production')),
  marketplace_id      text not null check (char_length(marketplace_id) between 1 and 32),
  marketplace_name    text,
  country_code        text,
  currency_code       text,
  store_name          text,
  seller_id           text check (char_length(seller_id) <= 64),
  participating       boolean,
  has_suspended_listings boolean,
  status              text not null default 'unverified' check (status in ('unverified', 'verified', 'failed')),
  verified_at         timestamptz,
  last_error_code     text check (char_length(last_error_code) <= 100),
  last_error_at       timestamptz,
  orders_watermark    timestamptz,
  catalog_synced_at   timestamptz,
  inventory_synced_at timestamptz,
  reports_synced_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, environment, marketplace_id),
  unique (org_id, id)
);

-- ---------------------------------------------------------------------------
-- amazon_sync_runs
-- ---------------------------------------------------------------------------
create table public.amazon_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  environment    text not null check (environment in ('sandbox', 'production')),
  marketplace_id text not null,
  kind           text not null check (kind in ('orders', 'catalog', 'inventory', 'reports')),
  status         text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed')),
  cursor         jsonb not null default '{}',
  window_start   timestamptz,
  window_end     timestamptz,
  counts         jsonb not null default '{}',
  error_code     text check (char_length(error_code) <= 100),
  error_message  text check (char_length(error_message) <= 500),
  requested_by   uuid default auth.uid() references auth.users (id) on delete set null,
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz,
  unique (org_id, id)
);
-- One active run per kind: a second click cannot start a parallel run.
create unique index amazon_sync_runs_one_active on public.amazon_sync_runs (org_id, environment, marketplace_id, kind)
  where status in ('queued', 'running', 'waiting');
create index amazon_sync_runs_recent on public.amazon_sync_runs (org_id, environment, started_at desc);

-- ---------------------------------------------------------------------------
-- amazon_orders / amazon_order_items  (no buyer or recipient columns exist)
-- ---------------------------------------------------------------------------
create table public.amazon_orders (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  environment       text not null check (environment in ('sandbox', 'production')),
  marketplace_id    text not null,
  amazon_order_id   text not null check (char_length(amazon_order_id) between 1 and 64),
  created_time      timestamptz not null,
  last_updated_time timestamptz not null,
  fulfillment_status text not null check (char_length(fulfillment_status) between 1 and 40),
  fulfilled_by      text check (fulfilled_by in ('MERCHANT', 'AMAZON')),
  sales_channel     text check (char_length(sales_channel) <= 80),
  item_count        integer not null default 0 check (item_count >= 0),
  unit_count        integer not null default 0 check (unit_count >= 0),
  ordered_value     numeric(14, 2) check (ordered_value >= 0),
  currency_code     text check (char_length(currency_code) <= 3),
  sync_run_id       uuid,
  synced_at         timestamptz not null default now(),
  unique (org_id, environment, marketplace_id, amazon_order_id),
  unique (org_id, id),
  foreign key (org_id, sync_run_id) references public.amazon_sync_runs (org_id, id) on delete set null (sync_run_id)
);
create index amazon_orders_by_time on public.amazon_orders (org_id, environment, created_time desc);

create table public.amazon_order_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  environment     text not null check (environment in ('sandbox', 'production')),
  marketplace_id  text not null,
  amazon_order_id text not null,
  order_item_id   text not null check (char_length(order_item_id) between 1 and 64),
  ordered_at      timestamptz not null,
  asin            text check (char_length(asin) <= 20),
  seller_sku      text check (char_length(seller_sku) <= 80),
  title           text check (char_length(title) <= 500),
  quantity        integer not null default 0 check (quantity >= 0),
  unit_price      numeric(12, 2) check (unit_price >= 0),
  currency_code   text check (char_length(currency_code) <= 3),
  unique (org_id, environment, marketplace_id, amazon_order_id, order_item_id),
  foreign key (org_id, environment, marketplace_id, amazon_order_id)
    references public.amazon_orders (org_id, environment, marketplace_id, amazon_order_id) on delete cascade
);
create index amazon_order_items_by_sku on public.amazon_order_items (org_id, environment, seller_sku, ordered_at desc);
-- Serves the dashboard and insight reads: every row of one organisation, environment and marketplace since a date.
create index amazon_order_items_by_time on public.amazon_order_items (org_id, environment, marketplace_id, ordered_at desc);

-- ---------------------------------------------------------------------------
-- amazon_products
-- ---------------------------------------------------------------------------
create table public.amazon_products (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete cascade,
  environment        text not null check (environment in ('sandbox', 'production')),
  marketplace_id     text not null,
  seller_sku         text not null check (char_length(seller_sku) between 1 and 80),
  asin               text check (char_length(asin) <= 20),
  title              text check (char_length(title) <= 500),
  brand              text check (char_length(brand) <= 200),
  product_type       text check (char_length(product_type) <= 100),
  image_url          text check (char_length(image_url) <= 1000),
  listing_status     text[] not null default '{}',
  listing_issues     jsonb not null default '[]',
  issue_error_count  integer not null default 0 check (issue_error_count >= 0),
  issue_warning_count integer not null default 0 check (issue_warning_count >= 0),
  sales_rank         jsonb,
  price              numeric(12, 2) check (price >= 0),
  currency_code      text check (char_length(currency_code) <= 3),
  listing_created_at timestamptz,
  listing_updated_at timestamptz,
  synced_at          timestamptz not null default now(),
  unique (org_id, environment, marketplace_id, seller_sku),
  unique (org_id, id)
);
create index amazon_products_by_asin on public.amazon_products (org_id, environment, asin);

-- ---------------------------------------------------------------------------
-- amazon_inventory (latest snapshot per SKU and source)
-- ---------------------------------------------------------------------------
create table public.amazon_inventory (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete cascade,
  environment        text not null check (environment in ('sandbox', 'production')),
  marketplace_id     text not null,
  seller_sku         text not null check (char_length(seller_sku) between 1 and 80),
  source             text not null check (source in ('fba', 'listing')),
  asin               text check (char_length(asin) <= 20),
  fn_sku             text check (char_length(fn_sku) <= 40),
  product_name       text check (char_length(product_name) <= 500),
  fulfillable        integer check (fulfillable >= 0),
  inbound_working    integer check (inbound_working >= 0),
  inbound_shipped    integer check (inbound_shipped >= 0),
  inbound_receiving  integer check (inbound_receiving >= 0),
  reserved           integer check (reserved >= 0),
  unfulfillable      integer check (unfulfillable >= 0),
  researching        integer check (researching >= 0),
  total_quantity     integer check (total_quantity >= 0),
  source_updated_at  timestamptz,
  synced_at          timestamptz not null default now(),
  unique (org_id, environment, marketplace_id, seller_sku, source)
);

-- ---------------------------------------------------------------------------
-- amazon_reports (metadata + parsed aggregates; the file itself is not stored)
-- ---------------------------------------------------------------------------
create table public.amazon_reports (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  environment       text not null check (environment in ('sandbox', 'production')),
  marketplace_id    text not null,
  report_type       text not null check (char_length(report_type) between 1 and 100),
  amazon_report_id  text not null check (char_length(amazon_report_id) between 1 and 64),
  document_id       text check (char_length(document_id) <= 100),
  processing_status text not null check (char_length(processing_status) <= 20),
  data_start_time   timestamptz,
  data_end_time     timestamptz,
  row_count         integer check (row_count >= 0),
  summary           jsonb not null default '{}',
  sync_run_id       uuid,
  fetched_at        timestamptz not null default now(),
  unique (org_id, environment, amazon_report_id),
  foreign key (org_id, sync_run_id) references public.amazon_sync_runs (org_id, id) on delete set null (sync_run_id)
);
create index amazon_reports_recent on public.amazon_reports (org_id, environment, report_type, fetched_at desc);

-- ---------------------------------------------------------------------------
-- amazon_insights
-- ---------------------------------------------------------------------------
create table public.amazon_insights (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  environment    text not null check (environment in ('sandbox', 'production')),
  marketplace_id text not null,
  kind           text not null check (kind in ('top_seller', 'sales_trend', 'low_inventory', 'inventory_risk', 'listing_issue', 'unusual_change')),
  severity       text not null check (severity in ('info', 'watch', 'act')),
  title          text not null check (char_length(title) between 1 and 200),
  summary        text not null check (char_length(summary) <= 2000),
  recommendation text not null check (char_length(recommendation) <= 2000),
  evidence       jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0),
  dedupe_key     text not null check (char_length(dedupe_key) between 1 and 200),
  generated_by   text not null default 'rules' check (generated_by in ('rules', 'claude')),
  model          text check (char_length(model) <= 100),
  status         text not null default 'draft' check (status in ('draft', 'submitted', 'dismissed')),
  approval_id    uuid,
  period_start   timestamptz,
  period_end     timestamptz,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (org_id, environment, dedupe_key),
  unique (org_id, id),
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete set null (approval_id)
);

-- ---------------------------------------------------------------------------
-- Row Level Security: default deny, then exactly these grants and policies
-- ---------------------------------------------------------------------------
alter table public.amazon_connections  enable row level security;
alter table public.amazon_sync_runs    enable row level security;
alter table public.amazon_orders       enable row level security;
alter table public.amazon_order_items  enable row level security;
alter table public.amazon_products     enable row level security;
alter table public.amazon_inventory    enable row level security;
alter table public.amazon_reports      enable row level security;
alter table public.amazon_insights     enable row level security;

revoke all on public.amazon_connections, public.amazon_sync_runs, public.amazon_orders, public.amazon_order_items,
  public.amazon_products, public.amazon_inventory, public.amazon_reports, public.amazon_insights from anon, authenticated;

grant select, insert, update, delete on public.amazon_connections, public.amazon_orders, public.amazon_order_items,
  public.amazon_products, public.amazon_inventory, public.amazon_reports, public.amazon_insights to authenticated;
grant select, insert, update on public.amazon_sync_runs to authenticated;   -- history is never deleted through the API

-- Synchronised data: any member reads; only owner/admin writes (the same people who may start a sync).
do $$
declare t text;
begin
  foreach t in array array['amazon_connections', 'amazon_orders', 'amazon_order_items', 'amazon_products', 'amazon_inventory', 'amazon_reports'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_member(org_id))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_admin(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_admin(org_id)) with check (private.is_admin(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_admin(org_id))', t || '_delete', t);
  end loop;
end $$;

create policy amazon_sync_runs_read   on public.amazon_sync_runs for select to authenticated using (private.is_member(org_id));
create policy amazon_sync_runs_insert on public.amazon_sync_runs for insert to authenticated with check (private.is_admin(org_id));
create policy amazon_sync_runs_update on public.amazon_sync_runs for update to authenticated
  using (private.is_admin(org_id)) with check (private.is_admin(org_id));

-- Insights. Only owner/admin create them (they come from the rules over synchronised data, so a staff member must not be able to plant a
-- "production" insight with invented evidence). Any writer may update, but the guard trigger below limits non-admins to status and approval_id.
create policy amazon_insights_read   on public.amazon_insights for select to authenticated using (private.is_member(org_id));
create policy amazon_insights_insert on public.amazon_insights for insert to authenticated with check (private.is_admin(org_id));
create policy amazon_insights_update on public.amazon_insights for update to authenticated
  using (private.can_write(org_id)) with check (private.can_write(org_id));
create policy amazon_insights_delete on public.amazon_insights for delete to authenticated using (private.is_admin(org_id));

-- ---------------------------------------------------------------------------
-- Guards that RLS alone cannot express
-- ---------------------------------------------------------------------------
-- 1. A row never changes organisation, environment or marketplace after it is written. Without this, an admin's UPDATE could relabel a sandbox
--    row as production (RLS only checks the organisation), which would break the sandbox/production separation.
create or replace function private.amazon_scope_immutable() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id or new.environment is distinct from old.environment or new.marketplace_id is distinct from old.marketplace_id then
    raise exception 'org_id, environment and marketplace_id cannot be changed';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['amazon_connections', 'amazon_sync_runs', 'amazon_orders', 'amazon_order_items', 'amazon_products', 'amazon_inventory', 'amazon_reports', 'amazon_insights'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.amazon_scope_immutable()', t || '_scope_immutable', t);
  end loop;
end $$;

-- 2. A signed-in user who is not owner/admin (an approver or staff member sending an insight to Approvals) may change only status and approval_id.
--    Statements with no signed-in user (the SQL editor, migrations) are not restricted.
create or replace function private.amazon_insight_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not private.is_admin(old.org_id) and
     row(new.kind, new.severity, new.title, new.summary, new.recommendation, new.evidence, new.dedupe_key, new.generated_by, new.model, new.period_start, new.period_end, new.created_by, new.created_at)
     is distinct from
     row(old.kind, old.severity, old.title, old.summary, old.recommendation, old.evidence, old.dedupe_key, old.generated_by, old.model, old.period_start, old.period_end, old.created_by, old.created_at) then
    raise exception 'only status and approval_id may be changed by this role';
  end if;
  return new;
end $$;

create trigger amazon_insights_guard before update on public.amazon_insights for each row execute function private.amazon_insight_guard();
