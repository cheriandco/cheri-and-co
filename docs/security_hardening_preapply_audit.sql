-- Cheri & Co. — read-only audit to run BEFORE applying 20261104000000_security_hardening.sql to a database that holds data (review finding F7).
-- It only reads. It changes nothing. Run it in the SQL editor as an administrator on the project you are about to migrate (staging first).
-- Every query below should return ZERO rows. Any row is data that the migration does not repair and that needs a person's decision first.
-- (An empty staging project returns nothing for all of them.)

-- A1. Posts that are approved or published, but have no approved approval behind them (approved by hand, or the approval was lost).
--     After the migration these cannot be re-approved except through reopen + submit + approve. They keep their status but have no record.
select c.id, c.org_id, c.title, c.status, c.approval_id
from public.content_items c
left join public.approvals a on a.org_id = c.org_id and a.id = c.approval_id
where c.status in ('approved', 'published')
  and (a.id is null or a.status not in ('approved', 'executed'));

-- A2. Posts waiting for approval whose approval is missing or already decided (stranded; reopen_content clears these for any writer).
select c.id, c.org_id, c.title, c.approval_id, a.status as approval_status
from public.content_items c
left join public.approvals a on a.org_id = c.org_id and a.id = c.approval_id
where c.status = 'pending_approval'
  and (a.id is null or a.status <> 'pending');

-- A3. Two or more posts linked to the same approval. The migration creates a unique index on content_items.approval_id and FAILS to apply
--     while any such pair exists. Fix these first (clear the link on all but the post the approval really belongs to).
select approval_id, count(*) as posts, array_agg(id) as post_ids
from public.content_items
where approval_id is not null
group by approval_id
having count(*) > 1;

-- A4. Approvals whose meta.postId names a post that is not linked back to them (forged or mismatched metadata).
select a.id as approval_id, a.org_id, a.title, a.meta ->> 'postId' as meta_post_id
from public.approvals a
where a.meta ? 'postId'
  and not exists (select 1 from public.content_items c
                  where c.org_id = a.org_id and c.approval_id = a.id and c.id::text = a.meta ->> 'postId');

-- A5. Approvals whose meta.postId is not a valid post of the same organisation at all.
select a.id as approval_id, a.org_id, a.meta ->> 'postId' as meta_post_id
from public.approvals a
where a.meta ? 'postId'
  and not exists (select 1 from public.content_items c where c.org_id = a.org_id and c.id::text = a.meta ->> 'postId');

-- A6. Approvals still carrying a caller-supplied allowedClaims list. The database ignores it from now on; this only tells you where it was used.
select a.id, a.org_id, a.title, a.status, a.meta -> 'allowedClaims' as allowed_claims
from public.approvals a
where a.meta ? 'allowedClaims' and a.meta -> 'allowedClaims' <> '[]'::jsonb;

-- A7. Posts that are too long to be sent for approval again (the approval preview limit is 6000 characters).
select c.id, c.org_id, c.title, c.status
from public.content_items c
where char_length('Platform: ' || c.platform || ' (simulated, not posted)' || E'\n' || 'Caption: ' || coalesce(c.caption, '') || E'\n'
  || 'Hashtags: ' || coalesce(array_to_string(c.hashtags, ' '), '') || E'\n' || 'Creative brief: ' || coalesce(c.creative_brief, '') || E'\n'
  || 'Image direction: ' || coalesce(c.image_direction, '')) > 6000;

-- ---------------------------------------------------------------------------------------------------------------------------
-- AFTER the migration has been applied (not before: it uses the migration's own claim function), find posts and approvals that were
-- already approved, published or waiting, and whose wording would be REFUSED by today's claim rules. They are not changed by the
-- migration; a person should look at them and, if needed, reopen and rewrite them. Expect zero rows on a clean project.
--
-- select c.id, c.org_id, c.title, c.status,
--        private.find_prohibited_claims(concat_ws(E'\n', c.title, c.topic, c.caption, array_to_string(c.hashtags, ' '), c.creative_brief, c.image_direction)) as hits
-- from public.content_items c
-- where c.status in ('pending_approval', 'approved', 'published')
--   and cardinality(private.find_prohibited_claims(concat_ws(E'\n', c.title, c.topic, c.caption, array_to_string(c.hashtags, ' '), c.creative_brief, c.image_direction))) > 0;
