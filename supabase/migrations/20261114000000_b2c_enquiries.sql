-- Cheri & Co. -- B2C Sales Agent: customer enquiries and the conversation history (Milestone 3, remediated after the independent audit).
--
-- STATUS: NOT APPLIED. Saved for review; the owner applies it in the Supabase SQL Editor. The enquiry API
-- (src/app/api/b2c/enquiries) answers 503 "not set up yet" until this migration is applied.
--
-- Why a migration: the foundation schema has no table for an enquiry or a message, and `content_items`/`approvals`/`tasks` do not fit
-- (a message needs a direction, a customer and a product). Everything else is reused: customers, products, approvals (the human decision),
-- tasks (follow-ups, via related_ref = '/b2c?enquiry=<enquiry id>') and agent_activity (history).
--
-- What it touches outside its own two tables (nothing else; no existing policy, grant or column is changed):
--   * ONE trigger on public.approvals (b2c_reply_sync), restricted by WHEN (new.type = 'B2C Reply'), so every other approval is untouched.
--     It copies a decision (approved / rejected) or an approver's edit of the wording onto the linked message in the SAME transaction.
--
-- Integrity is enforced HERE, not only in the application (audit finding H1): a writer who calls the database API directly cannot approve,
-- mark as sent, rewrite or detach anything. See private.guard_enquiry_message().
--   * inbound (customer) messages are immutable;
--   * an outbound reply is born a draft; its status may only move draft -> pending_approval -> approved | rejected, rejected -> draft,
--     approved -> sent_manually, and each step into pending/approved/rejected/sent needs an approval row of this organisation, of type
--     'B2C Reply', in the matching state, whose preview equals the message body (approved text and stored text cannot diverge);
--   * once a reply is pending, approved or sent its approval link and content are frozen (the only body change allowed while pending is
--     the copy of an approver's own edit, made by the approvals trigger);
--   * enquiries.status is maintained by trigger from the latest reply, and a writer may only close or reopen;
--   * NOTHING can hard-delete an enquiry message, and an enquiry that still has messages cannot be deleted (owner decision: the whole conversation and its
--     approval history are kept; use close/reopen). The only exception is deleting the whole organisation, which removes everything it owns by cascade.
--     Approvals and audit_log are untouched by this migration (users already cannot delete them).
--   * the internal helper functions (private.*) are not callable by application users; only the two RPCs are.
-- Data protection: these tables hold no contact details; a customer is referenced by id only. The message body is what a person typed in or
-- pasted. Nothing here is sent to an AI provider (see src/lib/b2c-live). Nothing here sends a message: 'approved' means a person approved
-- the wording; only a person records 'sent_manually'.
--
-- ROLLBACK (destroys all enquiries and messages). Run in this order:
--   drop trigger b2c_reply_sync on public.approvals;
--   drop function private.sync_b2c_reply();
--   drop function public.submit_b2c_reply(uuid, uuid, uuid, text, text, text);
--   drop function public.create_b2c_enquiry(uuid, text, uuid, uuid, text, text);
--   drop table public.enquiry_messages;
--   drop table public.enquiries;
--   drop function private.guard_enquiry_message(), private.guard_enquiry(), private.refresh_enquiry_status(), private.enquiry_derived_status(uuid);
--   drop function private.guard_enquiry_message_delete(), private.guard_enquiry_delete();
-- Optional cleanup of what the feature left behind in EXISTING tables (review each before running; none of it blocks the rollback):
--   -- reply approvals that were never decided (a decided approval has append-only audit_log rows, so deleting it is refused; leave those in place):
--   --   delete from public.approvals where type = 'B2C Reply';
--   -- follow-up tasks:
--   --   delete from public.tasks where source = 'B2C enquiry';
--   -- agent_activity rows with ref_type = 'enquiry' are append-only and cannot be deleted; they are harmless text.
--   -- customers created from an enquiry cannot be told apart by a column. BEFORE dropping the tables, list the linked ones and review them:
--   --   select c.* from public.customers c where c.id in (select customer_id from public.enquiries where customer_id is not null);

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
  -- 6000 matches approvals.preview, so an approver's edit of the wording always fits and the two texts can be kept identical.
  body         text not null check (char_length(body) between 1 and 6000),
  status       text not null default 'received'
               check (status in ('received', 'draft', 'pending_approval', 'approved', 'rejected', 'sent_manually')),
  product_id   uuid,
  approval_id  uuid,
  generated_by text not null default 'human' check (generated_by in ('customer', 'human', 'template', 'ai')),
  model        text check (char_length(model) <= 64),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  -- an inbound message is only ever 'received'; an outbound one never is
  check ((direction = 'inbound' and status = 'received') or (direction = 'outbound' and status <> 'received')),
  -- a state that depends on a decision always carries the approval; a draft never does
  check (status not in ('pending_approval', 'approved', 'sent_manually') or approval_id is not null),
  check (status <> 'draft' or approval_id is null),
  foreign key (org_id, enquiry_id) references public.enquiries (org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.products (org_id, id) on delete set null (product_id),
  -- no delete action on purpose: approvals are never deleted by the application, and a "set null" would fight the check above
  foreign key (org_id, approval_id) references public.approvals (org_id, id)
);

create index on public.enquiries (org_id, last_message_at desc);
create index on public.enquiries (org_id, customer_id);
create index on public.enquiries (org_id, product_id) where product_id is not null;
create index on public.enquiry_messages (org_id, enquiry_id, created_at);
create index on public.enquiry_messages (org_id, product_id) where product_id is not null;
-- the created_by foreign keys (deleting a user sets it to null; without an index that scan is sequential)
create index on public.enquiries (created_by) where created_by is not null;
create index on public.enquiry_messages (created_by) where created_by is not null;
-- for the "same message in the last ten minutes" duplicate check
create index on public.enquiry_messages (org_id, created_at desc) where direction = 'inbound';
-- one approval belongs to at most one message (also the lookup index for the approvals foreign key)
create unique index enquiry_messages_approval_key on public.enquiry_messages (org_id, approval_id) where approval_id is not null;
-- one live reply per enquiry: a draft or a reply waiting for a decision. Rejected, approved and sent replies stay as history and do not count.
create unique index enquiry_messages_one_live_reply on public.enquiry_messages (enquiry_id)
  where direction = 'outbound' and status in ('draft', 'pending_approval');

alter table public.enquiries enable row level security;
alter table public.enquiry_messages enable row level security;

revoke all on public.enquiries, public.enquiry_messages from anon, authenticated;
grant select, insert, update, delete on public.enquiries, public.enquiry_messages to authenticated;

-- Same shape as every other tenant table: read = member, write = writer role, delete = owner/admin. org_id is compared with the
-- caller's memberships, never trusted from the request. (The triggers below add the state rules RLS cannot express.)
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

-- ---------------------------------------------------------------------------
-- Enquiry status: derived from the latest reply, never typed in
-- ---------------------------------------------------------------------------
create or replace function private.enquiry_derived_status(p_enquiry uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select case coalesce((select m.status from public.enquiry_messages m where m.enquiry_id = p_enquiry and m.direction = 'outbound'
                         order by m.created_at desc, m.id desc limit 1), '')
    when '' then 'new'
    when 'sent_manually' then 'replied'
    when 'approved' then 'approved'
    when 'pending_approval' then 'awaiting_approval'
    else 'draft_ready'
  end
$$;

-- After any message change: bring the enquiry in line (a closed enquiry stays closed until a person reopens it).
-- Runs inside the statement that changed the message, so the two can never disagree.
create or replace function private.refresh_enquiry_status() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.enquiries set status = private.enquiry_derived_status(new.enquiry_id), last_message_at = now()
  where id = new.enquiry_id and org_id = new.org_id and status <> 'closed';
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Guard on messages (audit finding H1): the workflow is enforced by the database
-- ---------------------------------------------------------------------------
create or replace function private.guard_enquiry_message() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  a public.approvals;
  nested boolean := pg_trigger_depth() > 1; -- true when fired by a foreign-key action or by another trigger (never by a client statement)
  content_changed boolean;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); end if; -- cannot be spoofed
    if new.direction = 'outbound' and (new.status <> 'draft' or new.approval_id is not null) then
      raise exception 'a reply must start as a draft' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE: identity columns never change (created_by may only be cleared when the user account is deleted)
  if new.id <> old.id or new.org_id <> old.org_id or new.enquiry_id <> old.enquiry_id or new.direction <> old.direction or new.created_at <> old.created_at
     or (new.created_by is distinct from old.created_by and not (new.created_by is null and nested)) then
    raise exception 'this field cannot be changed' using errcode = 'P0001';
  end if;
  content_changed := new.body is distinct from old.body or new.generated_by <> old.generated_by or new.model is distinct from old.model
    or (new.product_id is distinct from old.product_id and not (new.product_id is null and nested));

  if old.direction = 'inbound' then
    if content_changed or new.status <> old.status or new.approval_id is distinct from old.approval_id then
      raise exception 'a customer message cannot be changed' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status = old.status then
    if old.status = 'draft' then
      if new.approval_id is not null then raise exception 'a draft has no approval' using errcode = 'P0001'; end if;
    elsif old.status = 'pending_approval' then
      if new.approval_id is distinct from old.approval_id or new.generated_by <> old.generated_by or new.model is distinct from old.model
         or (new.product_id is distinct from old.product_id and not (new.product_id is null and nested)) then
        raise exception 'a reply waiting for a decision cannot be changed' using errcode = 'P0001';
      end if;
      if new.body is distinct from old.body then
        -- only the copy of the approver's own edit (made by the approvals trigger) may change the text
        select * into a from public.approvals where id = new.approval_id and org_id = new.org_id and type = 'B2C Reply';
        if not found or a.status <> 'pending' or new.body <> a.preview then
          raise exception 'a reply waiting for a decision cannot be edited' using errcode = 'P0001';
        end if;
      end if;
    else
      -- rejected, approved, sent_manually: frozen
      if content_changed or new.approval_id is distinct from old.approval_id then
        raise exception 'a % reply cannot be changed', old.status using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

  -- status transitions: the only ones that exist
  if old.status = 'rejected' and new.status = 'draft' then
    if new.approval_id is not null then raise exception 'a draft has no approval' using errcode = 'P0001'; end if;
    return new; -- the person may have rewritten it; the link to the old approval is cleared
  end if;

  if not ((old.status = 'draft' and new.status = 'pending_approval') or (old.status = 'pending_approval' and new.status in ('approved', 'rejected'))
          or (old.status = 'approved' and new.status = 'sent_manually')) then
    raise exception 'a reply cannot move from % to %', old.status, new.status using errcode = 'P0001';
  end if;
  -- the link is set once (draft -> pending) and never replaced; who wrote it, which model and which product never change with a decision.
  -- The text may only change to the approval's own text (an approver's edit that travels with the decision), which is checked below.
  if new.approval_id is null or (old.status <> 'draft' and new.approval_id is distinct from old.approval_id)
     or new.generated_by <> old.generated_by or new.model is distinct from old.model or (new.product_id is distinct from old.product_id and not (new.product_id is null and nested)) then
    raise exception 'the approval link and the content cannot change with the status' using errcode = 'P0001';
  end if;
  -- the approval must exist, belong to this organisation, be a B2C reply approval, be in the right state, and carry exactly this text
  select * into a from public.approvals where id = new.approval_id and org_id = new.org_id and type = 'B2C Reply' and meta ->> 'kind' = 'b2c_reply';
  if not found then raise exception 'no valid reply approval' using errcode = 'P0001'; end if;
  if new.body <> a.preview then raise exception 'the text differs from the approval' using errcode = 'P0001'; end if;
  if new.status = 'pending_approval' and a.status <> 'pending' then raise exception 'the approval is not pending' using errcode = 'P0001'; end if;
  if new.status in ('approved', 'sent_manually') and a.status not in ('approved', 'executed') then raise exception 'the approval is not approved' using errcode = 'P0001'; end if;
  if new.status = 'rejected' and a.status <> 'rejected' then raise exception 'the approval is not rejected' using errcode = 'P0001'; end if;
  return new;
end $$;

create trigger enquiry_messages_guard before insert or update on public.enquiry_messages
  for each row execute function private.guard_enquiry_message();
create trigger enquiry_messages_refresh after insert or update on public.enquiry_messages
  for each row execute function private.refresh_enquiry_status();

-- Guard on enquiries: status is derived (or closed/reopened by a person), created_by is the real user, updated_at is maintained.
create or replace function private.guard_enquiry() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare nested boolean := pg_trigger_depth() > 1;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_by := auth.uid(); end if;
    if new.status <> 'new' then raise exception 'an enquiry starts as new' using errcode = 'P0001'; end if;
    return new;
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.created_at <> old.created_at
     or (new.created_by is distinct from old.created_by and not (new.created_by is null and nested)) then
    raise exception 'this field cannot be changed' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not nested then
    -- a person may only close an enquiry that has no reply waiting for a decision, or reopen it to the status its replies imply
    if new.status = 'closed' then
      if exists (select 1 from public.enquiry_messages m where m.enquiry_id = old.id and m.status = 'pending_approval') then
        raise exception 'a reply is waiting for a decision' using errcode = 'P0001';
      end if;
    elsif old.status <> 'closed' or new.status <> private.enquiry_derived_status(old.id) then
      raise exception 'the status follows the replies and cannot be set directly' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger enquiries_guard before insert or update on public.enquiries
  for each row execute function private.guard_enquiry();

-- Hard deletion is unsupported for enquiry conversations. These triggers fire for EVERY role (including the table owner); the delete policy and grant stay
-- in place so that a prohibited attempt gets this plain message instead of a bare "permission denied". The one exception is the cascade that happens when
-- the organisation itself is deleted (the organisation row is already gone when the cascade reaches these rows).
create or replace function private.guard_enquiry_message_delete() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations o where o.id = old.org_id) then
    raise exception 'Enquiry messages cannot be deleted: the conversation and its approval history are kept. Close the enquiry instead.' using errcode = 'P0001';
  end if;
  return old;
end $$;

create or replace function private.guard_enquiry_delete() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations o where o.id = old.org_id)
     and exists (select 1 from public.enquiry_messages m where m.enquiry_id = old.id) then
    raise exception 'An enquiry that has messages cannot be deleted: the conversation and its approval history are kept. Close the enquiry instead.' using errcode = 'P0001';
  end if;
  return old;
end $$;

create trigger enquiry_messages_no_delete before delete on public.enquiry_messages
  for each row execute function private.guard_enquiry_message_delete();
create trigger enquiries_no_delete before delete on public.enquiries
  for each row execute function private.guard_enquiry_delete();

-- ---------------------------------------------------------------------------
-- The decision is copied onto the message in the same transaction as decide_approval()
-- ---------------------------------------------------------------------------
create or replace function private.sync_b2c_reply() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.status in ('approved', 'executed', 'rejected') then
    -- the text travels with the decision, so an approval decided together with an edit leaves the message holding exactly the approved words
    update public.enquiry_messages set status = case when new.status = 'rejected' then 'rejected' else 'approved' end, body = new.preview
    where org_id = new.org_id and approval_id = new.id and status = 'pending_approval';
  elsif new.preview is distinct from old.preview then
    update public.enquiry_messages set body = new.preview where org_id = new.org_id and approval_id = new.id and status = 'pending_approval';
  end if;
  return null;
end $$;

create trigger b2c_reply_sync after update on public.approvals
  for each row when (new.type = 'B2C Reply') execute function private.sync_b2c_reply();

-- ---------------------------------------------------------------------------
-- Atomic operations used by the application (SECURITY INVOKER: row level security applies as the signed-in user)
-- ---------------------------------------------------------------------------

-- Logs an enquiry and its first message in one transaction. The same message, source and customer inside ten minutes returns the existing enquiry
-- (the advisory lock makes two simultaneous identical requests serialise, so only the first creates anything).
create or replace function public.create_b2c_enquiry(p_org_id uuid, p_source text, p_customer_id uuid, p_product_id uuid, p_subject text, p_message text)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare eid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || '|' || p_message, 0));
  select e.id into eid from public.enquiry_messages m
    join public.enquiries e on e.org_id = m.org_id and e.id = m.enquiry_id
    where m.org_id = p_org_id and m.direction = 'inbound' and m.body = p_message and m.created_at >= now() - interval '10 minutes'
      and e.source = p_source and e.customer_id is not distinct from p_customer_id
    limit 1;
  if found then return jsonb_build_object('id', eid, 'duplicate', true); end if;
  insert into public.enquiries (org_id, customer_id, product_id, source, subject) values (p_org_id, p_customer_id, p_product_id, p_source, p_subject) returning id into eid;
  insert into public.enquiry_messages (org_id, enquiry_id, direction, body, status, generated_by, product_id)
    values (p_org_id, eid, 'inbound', p_message, 'received', 'customer', p_product_id);
  return jsonb_build_object('id', eid, 'duplicate', false);
end $$;

-- Sends a draft to the Approval Centre in one transaction. The message row is locked, the approval is built FROM the locked text (never from what the
-- caller last saw), and p_expected_body makes a submit that raced an edit fail instead of approving stale wording. Retrying a submit that already
-- succeeded returns the same approval and creates nothing.
create or replace function public.submit_b2c_reply(p_org_id uuid, p_enquiry_id uuid, p_message_id uuid, p_expected_body text, p_title text, p_subject text)
returns public.approvals
language plpgsql security invoker set search_path = ''
as $$
declare m public.enquiry_messages; a public.approvals;
begin
  select * into m from public.enquiry_messages where id = p_message_id and enquiry_id = p_enquiry_id and org_id = p_org_id and direction = 'outbound' for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status = 'pending_approval' and m.body = p_expected_body then
    select * into a from public.approvals where id = m.approval_id and org_id = m.org_id;
    return a;
  end if;
  if m.status <> 'draft' then raise exception 'invalid state' using errcode = 'P0001'; end if;
  if m.body <> p_expected_body then raise exception 'draft changed' using errcode = 'P0001'; end if;
  insert into public.approvals (org_id, title, type, generated_by, status, preview, meta)
    values (m.org_id, left(p_title, 200), 'B2C Reply', 'b2c', 'pending', m.body,
            jsonb_strip_nulls(jsonb_build_object('kind', 'b2c_reply', 'subject', p_subject, 'isSample', false, 'allowedClaims', '[]'::jsonb, 'agent', 'b2c',
              'ref', m.enquiry_id, 'messageId', m.id, 'productId', m.product_id, 'aiAssisted', m.generated_by = 'ai', 'aiModel', m.model)))
    returning * into a;
  update public.enquiry_messages set status = 'pending_approval', approval_id = a.id where id = m.id;
  return a;
end $$;

revoke all on function public.create_b2c_enquiry(uuid, text, uuid, uuid, text, text), public.submit_b2c_reply(uuid, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.create_b2c_enquiry(uuid, text, uuid, uuid, text, text), public.submit_b2c_reply(uuid, uuid, uuid, text, text, text) to authenticated;

-- Internal helpers are not part of the API. Trigger functions are checked for EXECUTE only when a trigger is CREATED (by the migration owner), never when it fires,
-- and the definer functions that call enquiry_derived_status() run as their owner, so nothing below stops them. Without this, any signed-in user could call
-- private.enquiry_derived_status(<any enquiry id>) and read another organisation's status (the function is SECURITY DEFINER, so row level security does not apply).
revoke all on function private.enquiry_derived_status(uuid), private.refresh_enquiry_status(), private.guard_enquiry(), private.guard_enquiry_message(),
  private.guard_enquiry_message_delete(), private.guard_enquiry_delete(), private.sync_b2c_reply() from public, anon, authenticated;
