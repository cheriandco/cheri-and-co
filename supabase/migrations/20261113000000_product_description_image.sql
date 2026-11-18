-- Cheri & Co. -- add an optional description and an optional image link to products.
--
-- STATUS: NOT APPLIED. Saved for review; the owner applies it in the Supabase SQL Editor. The application code that
-- reads and writes these columns (src/services/live.ts, PRODUCT_COLS) needs this migration to be applied FIRST: until
-- it is, the live Products page cannot read the new columns and will show an error.
--
-- What it does: two nullable columns on public.products, with length and shape checks. Nothing else changes.
--   * Existing rows get NULL in both columns. No data is rewritten or removed.
--   * No new table, policy, grant, function or trigger. The existing table-level grants (select, insert, update, delete to
--     authenticated) and the existing row level security policies (read = member, write = owner/admin/approver/staff,
--     delete = owner/admin, org_id compared with the caller's memberships) already cover new columns.
--   * image_url is a LINK, not an uploaded file (no storage bucket is created). https only, so a javascript: or data: link
--     can never be stored; the length limit matches the application's validation.
--
-- Reversible by hand: alter table public.products drop column description, drop column image_url;
-- (this would discard whatever was entered in them).

alter table public.products
  add column if not exists description text
    constraint products_description_len check (description is null or char_length(description) <= 2000),
  add column if not exists image_url text
    constraint products_image_url_shape check (image_url is null or (char_length(image_url) <= 2048 and image_url ~* '^https://[^[:space:]]+$'));
