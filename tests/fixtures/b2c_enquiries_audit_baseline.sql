-- TEST FIXTURE ONLY. This is the B2C enquiries migration exactly as it stood when the independent audit found the workflow bypasses (H1, M4):
-- two tables, row level security, and NO triggers, NO partial unique index, NO FK lookup indexes. It is never applied anywhere. tests/b2c-enquiry-db.test.ts
-- runs the same attack scripts against this file (the attacks SUCCEED) and against the real migration (the attacks are REFUSED), which proves the regression
-- tests would have failed on the old implementation.

create table public.enquiries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  customer_id     uuid,
  product_id      uuid,
  source          text not null default 'other'
                  check (source in ('instagram', 'whatsapp', 'email', 'phone', 'website', 'walk_in', 'marketplace', 'other')),
  status          text not null default 'new'
                  check (status in ('new', 'draft_ready', 'awaiting_approval', 'approved', 'replied', 'closed')),
  subject         text not null check (char_length(subject) between 1 and 200),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete set null (customer_id),
  foreign key (org_id, product_id) references public.products (org_id, id) on delete set null (product_id)
);

create table public.enquiry_messages (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  enquiry_id   uuid not null,
  direction    text not null check (direction in ('inbound', 'outbound')),
  body         text not null check (char_length(body) between 1 and 2000),
  status       text not null default 'received'
               check (status in ('received', 'draft', 'pending_approval', 'approved', 'rejected', 'sent_manually')),
  product_id   uuid,
  approval_id  uuid,
  generated_by text not null default 'human' check (generated_by in ('customer', 'human', 'template', 'ai')),
  model        text check (char_length(model) <= 64),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  check ((direction = 'inbound' and status = 'received') or (direction = 'outbound' and status <> 'received')),
  foreign key (org_id, enquiry_id) references public.enquiries (org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.products (org_id, id) on delete set null (product_id),
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete set null (approval_id)
);

create index on public.enquiries (org_id, last_message_at desc);
create index on public.enquiries (org_id, customer_id);
create index on public.enquiry_messages (org_id, enquiry_id, created_at);

alter table public.enquiries enable row level security;
alter table public.enquiry_messages enable row level security;

revoke all on public.enquiries, public.enquiry_messages from anon, authenticated;
grant select, insert, update, delete on public.enquiries, public.enquiry_messages to authenticated;

do $$
declare t text;
begin
  foreach t in array array['enquiries', 'enquiry_messages'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_member(org_id))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.can_write(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.can_write(org_id)) with check (private.can_write(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_admin(org_id))', t || '_delete', t);
  end loop;
end $$;
