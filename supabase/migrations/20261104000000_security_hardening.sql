-- Cheri & Co. — security hardening (S1 and S2). Forward-only; the foundation migration is NOT edited.
--
-- STATUS: NOT APPLIED to any Supabase project. Tested only against a local in-process Postgres (tests/security-hardening.test.ts).
-- Apply to a STAGING project first (docs/STAGING_SETUP_AND_VERIFICATION.md), then production only after review.
--
-- S1  Prohibited claims are enforced inside decide_approval(), so calling the function directly cannot bypass the check.
-- S2  Content that is pending approval, approved or published cannot be changed directly. The status and the approval link
--     change only through three controlled functions: submit_content(), decide_approval() and reopen_content().
--
-- Roles and tenancy are unchanged: private.is_member / can_write / can_decide still decide who may do what, and every function
-- below re-checks them (SECURITY DEFINER bypasses RLS, so the checks are written out, not assumed).
-- Rollback: see "Rollback" in docs/SECURITY_HARDENING_REPORT.md. Data is not rewritten by this migration.

begin;

-- ---------------------------------------------------------------------------
-- S1. The claim rules, in SQL
-- ---------------------------------------------------------------------------
-- Same eight rules, same patterns and same order as src/lib/content-agent/claims.ts. Differences from JavaScript are only
-- (a) \y is Postgres' word boundary (in Postgres \b means "backspace"), and (b) Postgres picks the LONGEST alternative where
-- JavaScript picks the first, so the matched text can occasionally be longer; whether a rule fires is the same.
-- There is deliberately NO "approved claims" input: the application passes none for live content today, and a value supplied
-- by the caller (approvals.meta.allowedClaims) cannot be trusted because writers can insert approvals. Until a trusted source
-- of client-approved claims exists, every rule applies in full.
-- Returns one entry per match, formatted like the application: label: "matched text".
--
-- The text is normalised first (private.normalize_claim_text, the same steps as normalizeClaimText in claims.ts), so look-alike
-- spellings cannot slip past: no-break and special spaces, zero-width characters, other dash characters, fullwidth characters,
-- accents and Cyrillic/Greek letters that look Latin. A test fails if this copy drifts from the application's.
create or replace function private.normalize_claim_text(p_text text) returns text
language plpgsql immutable set search_path = ''
as $$
declare
  t text := normalize(coalesce(p_text, ''), NFKD);
begin
  t := regexp_replace(t, '[\u0300-\u036F]', '', 'g');
  t := normalize(t, NFKC);
  t := translate(t, 'АВЕКМНОРСТХаеорсухіјѕԁԛԝΑΒΕΖΗΙΚΜΝΟΡΤΥΧοανι', 'ABEKMHOPCTXaeopcyxijsdqwABEZHIKMNOPTYXoavi');
  t := regexp_replace(t, '[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]', '', 'g');
  t := regexp_replace(t, '[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]', '-', 'g');
  t := regexp_replace(t, '[\s\u0085\u2028\u2029]+', ' ', 'g');
  return t;
end;
$$;

create or replace function private.find_prohibited_claims(p_text text) returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(array_agg(r.label || ': "' || m.hit[1] || '"' order by r.ord, m.n), '{}'::text[])
  from (values
    (1, 'price', 'price', '(?:₹|\yrs\.?|\yinr\y|\yusd\y|\$)\s?\d|\y\d[\d,]*\s?(?:rupees|rs\y|inr\y)|\ystarting (?:at|from)\y|\yunder\s+(?:₹|rs\y|\d)'),
    (2, 'discount', 'discount or offer', '\y\d{1,3}\s?%\s?(?:off|discount)|\y(?:discounts?|on sale|sale|coupon|promo ?code|cashback|buy \d+ get \d+|limited[- ]time (?:offer|deal)|special offer|free (?:gift|shipping|delivery))\y'),
    (3, 'stock', 'stock or scarcity', '\y(?:in stock|out of stock|sold out|only \d+ left|last \d+ pieces?|few (?:pieces|left)|selling fast|limited stock|limited edition|almost gone|hurry)\y'),
    (4, 'material', 'material or durability', '\y(?:water[- ]?proof|water[- ]?resistant|sweat[- ]?proof|anti[- ]?tarnish|tarnish[- ]?(?:free|proof|resistant)|non[- ]?tarnish|rust[- ]?(?:free|proof)|hypoallergenic|skin[- ]?safe|nickel[- ]?free|lead[- ]?free|allergy[- ]?free|fade[- ]?proof|never fades?|long[- ]lasting|lifetime)\y'),
    (5, 'precious', 'precious metal or plating', '\y(?:real|genuine|pure|authentic) (?:gold|silver|diamonds?|platinum)\y|\y(?:925|sterling) silver\y|\y(?:14|18|22|24)\s?k(?:t|arat)?\y|\y(?:gold|silver)[- ]plated\y'),
    (6, 'certification', 'certification', '\y(?:certified|hallmark(?:ed)?)\y'),
    (7, 'superlative', 'guarantee or superlative', '\y(?:best price|lowest price|cheapest|guarantee(?:d)?|100\s?%|best[- ]?sellers?|bestselling|number one)\y|#1\y'),
    (8, 'medical', 'health claim', '\y(?:cures?|heals?|therapeutic|anti[- ]?allergic)\y')
  ) as r(ord, id, label, pat)
  cross join lateral regexp_matches(private.normalize_claim_text(p_text), r.pat, 'gi') with ordinality as m(hit, n)
$$;

-- Not callable from the Data API: only the SECURITY DEFINER functions below (owned by the migration role) use them.
revoke all on function private.normalize_claim_text(text) from public, anon, authenticated;
revoke all on function private.find_prohibited_claims(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- S2. Guards that apply to signed-in API callers only
-- ---------------------------------------------------------------------------
-- current_user is the role the statement runs as. A user's own request runs as "authenticated". Code inside a SECURITY DEFINER
-- function runs as the function owner, and the SQL editor / service role run as their own roles, so those pass. No setting or
-- flag that a caller could set is involved.

create or replace function private.content_items_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'identity columns of a content item cannot be changed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.approval_id is distinct from old.approval_id then
    raise exception 'status and approval link change only through submit_content, decide_approval and reopen_content' using errcode = '42501';
  end if;
  if old.status in ('pending_approval', 'approved', 'published')
     and (new.platform is distinct from old.platform or new.title is distinct from old.title or new.topic is distinct from old.topic
          or new.caption is distinct from old.caption or new.hashtags is distinct from old.hashtags
          or new.creative_brief is distinct from old.creative_brief or new.image_direction is distinct from old.image_direction) then
    raise exception 'this content is locked while it is pending approval, approved or published; reopen it first' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists content_items_guard on public.content_items;
create trigger content_items_guard before update on public.content_items
  for each row execute function private.content_items_guard();

-- A new post starts as a plain draft with no approval, so nobody can insert a row that already looks approved.
alter policy content_items_insert on public.content_items
  with check (private.can_write(org_id) and status = 'draft' and approval_id is null);

-- Approval metadata that says "this approval belongs to post X" or "these claims are allowed" is written only by
-- submit_content(). A writer's direct insert may not carry it, so it cannot be forged.
create or replace function private.approvals_meta_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and new.meta is not null and jsonb_typeof(new.meta) = 'object'
     and (new.meta ? 'postId' or new.meta ? 'allowedClaims' or new.meta ->> 'kind' = 'content_draft') then
    raise exception 'postId, allowedClaims and kind=content_draft are set only by the approval workflow' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists approvals_meta_guard on public.approvals;
create trigger approvals_meta_guard before insert on public.approvals
  for each row execute function private.approvals_meta_guard();

-- Activity rows that point at a content item or an approval are written only by submit_content / reopen_content, so a writer
-- cannot forge "reopened" or "submitted" history for a post. Ordinary activity (no reference) is unchanged. The actor must still be
-- the caller, as before.
alter policy agent_activity_insert on public.agent_activity
  with check (private.can_write(org_id) and actor_id is not distinct from (select auth.uid())
              and coalesce(ref_type, '') not in ('content_item', 'approval'));

-- ---------------------------------------------------------------------------
-- submit_content: draft -> pending approval, in one transaction
-- ---------------------------------------------------------------------------
-- Builds the approval text and metadata itself from the stored post (same layout as renderPostForApproval in
-- src/lib/social/posts.ts), checks the claim rules, creates the approval, links it, and records the activity. Any failure rolls
-- all of it back, so there is no half-submitted post and no orphan approval.
create or replace function public.submit_content(p_post uuid) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  c public.content_items;
  preview_text text;
  hits text[];
  new_approval uuid;
begin
  select * into c from public.content_items where id = p_post for update;
  if not found or not private.is_member(c.org_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not private.can_write(c.org_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if c.status <> 'draft' or c.approval_id is not null then
    raise exception 'only drafts can be submitted for approval' using errcode = 'P0001';
  end if;
  if c.caption is null or btrim(c.caption) = '' then
    raise exception 'a caption is required' using errcode = '22023';
  end if;

  preview_text := 'Platform: ' || c.platform || ' (simulated, not posted)' || E'\n'
    || 'Caption: ' || c.caption || E'\n'
    || 'Hashtags: ' || case when cardinality(c.hashtags) > 0 then array_to_string(c.hashtags, ' ') else '[none]' end || E'\n'
    || 'Creative brief: ' || coalesce(nullif(c.creative_brief, ''), '[none]') || E'\n'
    || 'Image direction: ' || coalesce(nullif(c.image_direction, ''), '[none]');

  -- The approvals table limits the preview to 6000 characters. Say so plainly instead of failing on the table's check.
  if char_length(preview_text) > 6000 then
    raise exception 'the post is too long to send for approval (limit 6000 characters)' using errcode = '22023';
  end if;

  -- The title and topic are scanned as well (they are not part of the preview, but they appear in the queue and on the calendar).
  hits := private.find_prohibited_claims(concat_ws(E'\n', c.title, c.topic, preview_text));
  if cardinality(hits) > 0 then
    raise exception 'prohibited claims: %', array_to_string(hits, ' | ') using errcode = '23514';
  end if;

  insert into public.approvals (org_id, title, type, generated_by, status, preview, meta)
  values (c.org_id, left(c.title || ' · ' || c.platform || ' post', 200), 'Content', 'content', 'pending', preview_text,
          jsonb_build_object('kind', 'content_draft', 'subject', c.title, 'isSample', false, 'allowedClaims', '[]'::jsonb, 'postId', c.id))
  returning id into new_approval;

  update public.content_items set status = 'pending_approval', approval_id = new_approval where id = c.id;

  insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id)
  values (c.org_id, 'content', left('Sent "' || c.title || '" (' || c.platform || ') for approval', 500), 'content_item', c.id, (select auth.uid()));

  return new_approval;
end;
$$;

-- ---------------------------------------------------------------------------
-- reopen_content: back to an editable draft, only where that is legitimate
-- ---------------------------------------------------------------------------
--   rejected                      -> any writer
--   pending, but no pending       -> any writer (a submission that lost its approval; nothing is waiting for a decision)
--     approval behind it
--   approved or published         -> owner, admin or approver only (it withdraws an approved post; it must be approved again)
--   pending with a pending approval -> refused: decide it first
-- The approval row is never changed or deleted (it is the record of what was decided).
create or replace function public.reopen_content(p_post uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c public.content_items;
begin
  select * into c from public.content_items where id = p_post for update;
  if not found or not private.is_member(c.org_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not private.can_write(c.org_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if c.status = 'draft' then
    return;
  elsif c.status = 'pending_approval' then
    if exists (select 1 from public.approvals a where a.org_id = c.org_id and a.id = c.approval_id and a.status = 'pending') then
      raise exception 'this post is waiting for a decision' using errcode = 'P0001';
    end if;
  elsif c.status in ('approved', 'published') then
    if not private.can_decide(c.org_id) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  update public.content_items set status = 'draft', approval_id = null where id = c.id;

  insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id)
  values (c.org_id, 'content',
          left('Reopened "' || c.title || '" (' || c.platform || ') for editing'
               || case when c.status in ('approved', 'published') then '; it had been ' || c.status || ' and needs approval again' else '' end, 500),
          'content_item', c.id, (select auth.uid()));
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_approval: same signature, same roles, same audit row; now also
--   * finds the post through content_items.approval_id (a trusted foreign key), never through caller-supplied metadata
--   * refuses an approval whose meta.postId names a different post
--   * applies the claim rules before an approval of content, whatever the caller sends
--   * moves the post to approved/rejected in the same transaction
-- ---------------------------------------------------------------------------
create or replace function public.decide_approval(
  p_id uuid, p_action text, p_note text default null, p_title text default null, p_preview text default null
) returns public.approvals
language plpgsql security definer set search_path = ''
as $$
declare
  a public.approvals;
  c public.content_items;
  has_post boolean;
  post_follows boolean;
  hits text[];
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

  select * into c from public.content_items where org_id = a.org_id and approval_id = a.id for update;
  has_post := found;

  -- A content approval is the record of exactly what the post said when it was submitted, and the post is locked while it waits.
  -- Changing the approval text would let the approved text differ from the post, so it cannot be edited: reject it, and the
  -- post can then be reopened, changed and submitted again.
  if p_action = 'edit' and has_post then
    raise exception 'a content approval cannot be edited; reject it and change the post instead' using errcode = 'P0001';
  end if;

  if has_post then
    post_follows := c.status = 'pending_approval'
                    and (a.meta ->> 'postId' is null or a.meta ->> 'postId' = c.id::text);
    -- Approving needs a consistent post. Rejecting never does: it is how a stranded approval (one whose post has moved on, or
    -- whose metadata is wrong) is cleared. In that case only the approval is rejected and the post is left as it is.
    if p_action = 'approve' and not post_follows then
      if c.status <> 'pending_approval' then
        raise exception 'the post is not waiting for approval' using errcode = 'P0001';
      end if;
      raise exception 'approval metadata does not match its post' using errcode = '22023';
    end if;
  else
    post_follows := false;
  end if;

  if p_action = 'approve' and (has_post or a.generated_by = 'content' or a.type = 'Content') then
    hits := private.find_prohibited_claims(
      concat_ws(E'\n', a.title, a.preview,
        case when has_post then concat_ws(E'\n', c.title, c.topic, c.caption, array_to_string(c.hashtags, ' '), c.creative_brief, c.image_direction) end));
    if cardinality(hits) > 0 then
      raise exception 'prohibited claims: %', array_to_string(hits, ' | ') using errcode = '23514';
    end if;
  end if;

  update public.approvals set
    status  = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else status end,
    title   = case when p_action = 'edit' then coalesce(p_title, title) else title end,
    preview = case when p_action = 'edit' then coalesce(p_preview, preview) else preview end
  where id = p_id
  returning * into a;

  insert into public.audit_log (org_id, approval_id, action, actor_id, note)
  values (a.org_id, a.id, p_action, (select auth.uid()), p_note);

  if post_follows and p_action in ('approve', 'reject') then
    update public.content_items set status = case p_action when 'approve' then 'approved' else 'rejected' end where id = c.id;
  end if;

  return a;
end;
$$;

-- Execution rights. Signed-in users only; never anonymous visitors.
revoke all on function public.decide_approval(uuid, text, text, text, text) from public, anon;
grant execute on function public.decide_approval(uuid, text, text, text, text) to authenticated;
revoke all on function public.submit_content(uuid) from public, anon;
grant execute on function public.submit_content(uuid) to authenticated;
revoke all on function public.reopen_content(uuid) from public, anon;
grant execute on function public.reopen_content(uuid) to authenticated;

commit;
