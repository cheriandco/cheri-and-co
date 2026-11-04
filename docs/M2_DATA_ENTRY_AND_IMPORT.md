# M2: data entry and CSV import (customers, retailers, tasks, orders)

Status: **implemented on `feature/client-delivery` (local, uncommitted). Verified only with local tests (fakes and component rendering). NOT verified against a hosted Supabase project and NOT seen in a browser with live data** (no staging project exists; the demo hides these forms by design).

Scope kept to M2: no new agents, no new dashboard module, no redesign, no new table or migration, no new dependency. It works with the **foundation migration alone** (`supabase/migrations/20261101000000_foundation.sql`); it does not use anything from the security-hardening migration.

## Where things are

| Record | Create | Edit | Import | Manage |
|---|---|---|---|---|
| Customers | Customers page, "Add a customer" | Customer detail page, "Edit customer" | Customers page, "Import customers from CSV" | edit form |
| Retailers | Retailers page, "Add a retailer" (also creates its first pipeline lead) | Retailer detail page, "Edit retailer" (stage and score untouched) | Retailers page | edit form; the pipeline board moves stages (unchanged) |
| Tasks | Tasks page, "Add a task" | n/a | Tasks page | Complete / Postpone buttons (unchanged) |
| Orders | Customers page, "Orders" section, "Record an order" | n/a | Orders section, "Import orders from CSV" | status drop-down per order |

**Orders have no page of their own.** The brief said no new dashboard modules, so the order form, list and import sit in an "Orders" section under the Customers page. A dedicated Orders page is a separate decision (it was priced as option O4 in the roadmap).

All of this appears only for a **real organisation** and only to roles that may write (owner, admin, approver, staff). Viewers see lists but no forms. The sample demo is unchanged: no forms, and the import route answers 404.

## CSV format

Download the template from each import panel. UTF-8, comma separated, first row is the header. Column names are matched loosely (capitals, spaces and dashes do not matter). Unknown columns are ignored and listed as a warning. At most **200 rows** and 500,000 characters per file.

| Import | Columns (required in bold) | Duplicate means |
|---|---|---|
| customers | **name**, email, phone, instagram, city, interests (separate with `;`) | same email, same phone (last 10 digits), same Instagram handle; or, if none of those is given, same name and city |
| retailers | **business**, location, category, contact, email, phone, instagram, website, qualification | same business name in the same location, same email, or same phone |
| tasks | **title**, priority (high/medium/low, blank = medium), due (Today, Tomorrow, This week, or `YYYY-MM-DD`, blank = unscheduled) | an open task with the same title (finished tasks do not count) |
| orders | **channel** (instagram, amazon, flipkart, b2b, other), **total**, status (blank = new), ordered_at (`YYYY-MM-DD`, blank = now), customer_email, retailer_business, items | same customer, retailer, channel, total and day. Rows with no date are never called duplicates |

Orders find the customer by **email** and the retailer by **business name**, among records that already exist, so import customers and retailers first. An unknown or ambiguous email or name makes that row invalid. `items` is optional text such as `Kundan Choker x1; Pearl Studs x2`; it is stored as line items with a quantity.

## How an import works

1. Choose a file. The server checks every row and returns a **preview**; nothing is saved.
2. The preview shows each row as **Ready**, **Duplicate** (skipped, with what it matches) or **Problem** (skipped, with the reason and the line number). A file with a missing required column, a repeated column, no rows, too many rows or an unclosed quotation mark is refused whole, with the reason.
3. "Import N" saves the ready rows. The server **re-checks the file and re-reads existing records at that moment**, so a stale preview cannot import anything the server would now refuse.
4. A summary shows how many rows were imported, skipped as duplicates, skipped as problems, and any row the database refused (with its line).

Rows are saved one at a time through the same code as the forms, so the same validation, the session's organisation and the same database policies apply. A row that fails does not stop the others. **A file with some bad rows is therefore imported partially (the good rows are saved, the bad ones reported).** The roadmap's earlier acceptance line said a bad row should import nothing partially; the brief for this work asked for per-row reporting, so the per-row behaviour was built. Say if you want all-or-nothing instead.

## Permissions and safety

- Import needs the same permission as creating one record by hand: customers and retailers `pipeline:write`, tasks `tasks:write`, orders `orders:write` (owner, admin, approver and staff; not viewer). The cross-site (CSRF) check applies as for every write route.
- The organisation always comes from the signed-in session; an `org_id` column in a file is ignored. A customer or retailer from another organisation cannot be matched by an order row.
- Spreadsheet formulas in cells (`=...`) are stored as plain text; nothing is evaluated.
- Import writes **one** activity line ("Imported 12 customers from a CSV file") instead of one per row.
- Existing Row Level Security is untouched; no policy, table or function was added.

## New and changed endpoints

| Route | Notes |
|---|---|
| `POST /api/import/:resource` (`customers`, `retailers`, `tasks`, `orders`) | Body `{ csv, commit? }`. Without `commit`: preview. With `commit: true`: re-check and save. Returns `{ report }` or `{ report, created, failed }`. `400` no `csv`; `403` role or cross-site; `404` unknown resource or sample demo. |
| `PATCH /api/customers/:id` | Replaces the editable fields (a blank value clears a field). `400` invalid; `404` not in this organisation or demo. |
| `PATCH /api/retailers/:id` | Same, for retailer details. The lead's stage and score are not changed. |

`POST /api/customers`, `/retailers`, `/tasks`, `/orders` and `PATCH /api/orders/:id` (status) existed before M2 and are used by the new forms.

## Files

New: `src/lib/csv.ts`, `src/lib/import.ts`, `src/lib/forms.ts`, `src/services/import.ts`, `src/app/api/import/[resource]/route.ts`, `src/components/record-form.tsx`, `src/components/import-panel.tsx`, `src/components/order-table.tsx`, `tests/csv-import.test.ts`, `tests/m2-api.test.ts`, `tests/m2-components.test.ts`.
Changed: `src/services/live.ts`, `src/services/index.ts`, `src/app/api/[resource]/[id]/route.ts`, the Customers, Customer detail, Retailers, Retailer detail and Tasks pages, `docs/API.md`, `docs/FINAL_DELIVERY_ROADMAP.md`.

## Limitations (honest list)

- **Not run against a real database.** Tests use a recording fake client and component rendering. RLS, the composite foreign keys and real insert behaviour are exercised only by the staging run (M1), which has not happened.
- **Not seen in a browser with live data.** The forms render only for a real organisation; there is no staging project to sign in to.
- Import saves up to 200 rows one at a time (slow on a slow connection; the route allows 60 seconds). Larger files must be split.
- Task assignees are not stored (existing limit), so imported tasks are "Unassigned".
- Order details cannot be edited after recording (only the status), and orders cannot be deleted from the screen.
- The order form's customer and retailer pick-lists show the 500 most recent records; the CSV import finds them by email or name instead. There is no search-as-you-type picker.
- Duplicate checks are by the keys above, not fuzzy: "Jon Smith" and "John Smith" with different contact details are two customers.
- Dates in the forms and in CSV files must be `YYYY-MM-DD` (tasks also accept Today, Tomorrow, This week) (day/month/year spellings are refused rather than guessed).
- Customer contact rules are slightly stricter in imports than in the form API (a malformed email or a phone with fewer than 6 digits is a Problem row); the form fields are only length-checked by the server.
- An import is not atomic across rows, and there is no undo; deleting wrongly imported records is not possible from the screen (owner/admin can delete only in the database).
- Only the import and edit paths were verified on the foundation migration. The security-hardening migration (separate branch) does not change any of these tables.
