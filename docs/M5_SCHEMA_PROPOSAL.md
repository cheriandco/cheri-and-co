# M5.1: Amazon schema proposal (FOR APPROVAL, NOTHING CREATED)

Status: **reviewed; a LOCAL migration file now exists (`supabase/migrations/20261111000000_amazon_intelligence.sql`, generated from the SQL block below and checked identical to it by a test). It has NOT been applied anywhere.** The SQL below was
loaded into the project's in-process Postgres (PGlite) on top of the foundation migration and exercised there with RLS checks (section 8); that proves
the SQL parses and the policies behave as described, **not** that it works on Supabase. The migration is forward-only, on the foundation lineage, and is to be applied to a staging project first (M1, deferred) only after your explicit approval.

The application code written for M5 already targets these table and column names and refuses to run against a database that lacks them
(the Amazon page then says the tables are not installed), so approving or changing this proposal is the only gate before it can store anything.

## 1. Principles

- **Organisation isolation.** Every table carries `org_id` and uses the same helpers as the foundation (`private.is_member`, `private.is_admin`,
  `private.can_write`). Policies compare `org_id` with the caller's memberships, never with anything the browser sends.
- **Environment separation.** Every table carries `environment` (`'sandbox'` or `'production'`), and the environment is part of every unique key, so a
  sandbox row can never collide with, overwrite or be counted as a production row. The application reads only the environment it is configured for.
- **No buyer data, by construction.** There is no column for a buyer name, address, phone, email or Amazon buyer id, and the application
  never requests `BUYER` or `RECIPIENT` order data. No raw API payload is stored (raw payloads can carry fields we did not ask for).
- **No secrets.** Tokens and client secrets stay in server environment variables. No table holds a credential.
- **Existing tables are untouched.** `orders`, `products`, `customers`, `approvals`, `agent_activity`, `audit_log` are not altered. Amazon orders
  stay out of `orders` because the Sales report counts only `delivered` orders as revenue, Amazon has no "delivered" order status, and M4 keys on customers.
- **Approvals reuse the existing path.** An insight becomes an `approvals` row (`generated_by = 'amazon'`, which the foundation already allows,
  `type` is free text). No change to `decide_approval()`.

## 2. Tables

| Table | Purpose | Written by | Natural unique key |
|---|---|---|---|
| `amazon_connections` | One row per organisation, environment and marketplace: verification result and sync watermarks. Holds no secret. | owner/admin | `(org_id, environment, marketplace_id)` |
| `amazon_sync_runs` | One row per sync attempt (orders, catalog, inventory, reports); carries the resumable cursor. | owner/admin | at most one active run per `(org_id, environment, marketplace_id, kind)` |
| `amazon_orders` | Order headers: ids, times, fulfillment status, totals as reported. No buyer data. | owner/admin (sync) | `(org_id, environment, marketplace_id, amazon_order_id)` |
| `amazon_order_items` | Order lines: ASIN, SKU, title, quantity, unit price. | owner/admin (sync) | `(…order key…, order_item_id)` |
| `amazon_products` | Seller listings: SKU, ASIN, title, brand, status, issues, sales rank. | owner/admin (sync) | `(org_id, environment, marketplace_id, seller_sku)` |
| `amazon_inventory` | Latest quantities per SKU and source (`fba` or `listing`). | owner/admin (sync) | `(org_id, environment, marketplace_id, seller_sku, source)` |
| `amazon_reports` | Metadata and parsed aggregates of retrieved reports. The report file is not kept. | owner/admin (sync) | `(org_id, environment, amazon_report_id)` |
| `amazon_insights` | Rules-based insights with their evidence and approval link. | create: owner/admin. Approver/staff may only set `status` and `approval_id` (trigger) | `(org_id, environment, dedupe_key)` |

## 3. Draft SQL

```sql
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
```

## 4. Keys, constraints and indexes at a glance

- **Primary keys:** `uuid` on every table.
- **Tenant integrity:** composite foreign keys keep a row from pointing at another organisation's record: order items to their order (same org, environment,
  marketplace and order id), orders and reports to their sync run, insights to their approval (the same pattern `content_items` uses).
- **Environment in every unique key** (section 2), so sandbox and production data cannot meet.
- **One active run per kind** through a partial unique index.
- **Indexes:** orders and items by `(org_id, environment, time)`, items by SKU, products by ASIN, reports by type and fetch time, runs by recency.
  Every unique key is also an index.
- **Deliberately no `check` on Amazon's status words** (`fulfillment_status` is length-checked only), so a new status Amazon introduces cannot make a sync fail.

## 5. Idempotent, resumable synchronisation

- **Upserts.** Every write is `INSERT … ON CONFLICT (natural key) DO UPDATE`. Running a sync twice produces the same rows. A page retried after a failure rewrites the same rows.
- **Orders** are fetched with `lastUpdatedAfter = amazon_connections.orders_watermark` and a `lastUpdatedBefore` at least 5 minutes in the past (Amazon requires at least 2).
  The watermark moves forward **only** when a whole window finishes, so a failure never skips orders. The first run covers a configurable look-back (default 30 days).
- **Resume.** The run row stores the cursor: the orders `paginationToken` (valid 24 h), the catalog `pageToken`, or the report id. A step does a bounded amount of work, saves the cursor and
  returns "more to do"; the next call continues. Orders are rate-limited to about one request per 3 minutes after the burst, so a large backfill is expected to take several steps.
- **Inventory** cannot resume across calls because Amazon's `nextToken` lives 30 seconds. It runs to completion in one call, and a failed attempt simply starts again (idempotent).
- **Reports** are asynchronous: step 1 creates the report (run goes `waiting`, cursor holds the report id), later steps poll `getReport`, then fetch and parse the document once.
- **Failure handling.** Throttling is not a failure: the step stops cleanly with a retry time. Other errors mark the run `failed` with a short redacted code and message and release the one-active-run lock.

## 6. Data retention

- **Amazon only returns about two years of orders for India**; the app never requests more.
- Order and item rows hold no personal data, so no retention duty arises from them; a reasonable default is to keep them for the life of the account.
- `amazon_sync_runs` grows by a handful of rows per sync. There is no delete policy, so pruning (for example keep 12 months) is a manual administrator action in the SQL editor.
- Report files are not stored, only parsed aggregates. Insights are kept until an owner or admin deletes them.
- Sandbox rows are test data and may be deleted at any time by an admin (`delete from … where environment = 'sandbox'`).
- If the client ever removes the Amazon connection, deleting the organisation's rows from these tables is a plain `delete` by environment; nothing else references them.

## 7. What this proposal does not include

No table for buyers, reviews, competitors or pricing, no advertising data, no stored credentials, no write-back to Amazon, and no change to `orders`, `products`
or any existing table.

## 8. How the draft was checked (PGlite only)

Loaded after the foundation migration in the project's in-process Postgres, with the same stubs `tests/rls.test.ts` uses. Checked: it applies cleanly; RLS is enabled on all eight tables; signed-out users
read nothing; a member reads only their organisation's rows; a viewer, staff or approver cannot write synchronised tables or create insights (owner/admin only); approver and staff can only set `status` and `approval_id` on an insight, enforced by a trigger; an owner/admin can do both; a second organisation sees
nothing and cannot insert into the first; a sandbox and a production row with the same Amazon order id coexist; a second active run for the same kind is refused; deleting a sync run keeps its
orders; an order item cannot reference another environment's order; an insight cannot link another organisation's approval. Results are in the final M5 report. **None of this has run on Supabase.**

## 8b. Review findings fixed in the SQL (M5 review)

1. **Environment relabelling.** RLS checks only the organisation, so an admin's `UPDATE ... SET environment = 'production'` would have turned sandbox rows into production rows. A `before update` trigger on all eight tables now refuses any change to `org_id`, `environment` or `marketplace_id`.
2. **Planted insights.** Any writer could insert an insight with invented evidence and `environment = 'production'`. Insight inserts are now owner/admin only (`generate` needs `amazon:sync`), and approver/staff may update only `status` and `approval_id` (guard trigger; statements with no signed-in user, such as the SQL editor, are unrestricted).
3. **Missing index** for "all items of one organisation, environment and marketplace since a date" (the dashboard and insight read). Added `amazon_order_items_by_time`.

Known limits that this migration does not change: `approvals` has no environment column and its insert policy lets any writer queue a pending item with arbitrary `meta` (existing foundation behaviour, shared by every agent). The application refuses sandbox insights, but the database cannot. A hardening option, now written up as a separate proposal that is NOT applied and NOT part of this migration (see `docs/M5_APPROVAL_HARDENING.md`; it adds a trigger to an existing table): a trigger on `approvals` that rejects `meta.kind = 'amazon_insight'` unless the referenced insight exists in the same organisation with `environment = 'production'`.

## 9. Decisions requested

1. Approve the eight tables, or tell me what to change.
2. Confirm sandbox rows may be stored in the same tables (tagged by `environment`) rather than only in a staging database.
3. Confirm the default first-sync look-back of 30 days.
