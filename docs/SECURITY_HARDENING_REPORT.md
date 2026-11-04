# Security hardening report (S1 and S2)

**Status: implemented in the repository, tested locally, NOT applied to any Supabase project, NOT committed.**
Migration: `supabase/migrations/20261104000000_security_hardening.sql` (new; the foundation migration is untouched).
All tests below run on an in-process Postgres (PGlite) or on fakes. **No hosted verification has been performed.**
**Revised after an independent security review** (findings F1, F3, F4, F5, F6 and F12 are fixed in this version; see section 7). Items from that review that
were not approved for this pass are listed in section 7 as still open.

Closes the two issues left open in `docs/OVERNIGHT_STABILISATION_REPORT.md`:

1. The prohibited-claims check ran only in the application, so a direct call to `decide_approval()` skipped it.
2. A writer could change an approved post's wording directly, or mark a post approved without any approval.

---

## 1. S1 — prohibited claims inside the database approval step

### What was built
- `private.find_prohibited_claims(text)` returns the matches of the same **eight rules, same patterns, same order** as `src/lib/content-agent/claims.ts` (price, discount or offer,
  stock or scarcity, material or durability, precious metal or plating, certification, guarantee or superlative, health claim). The phrase list was **not** changed or extended.
  The function is not executable by signed-in users or visitors; only the privileged functions below call it.
- `decide_approval()` (same signature, same roles, same audit row) now, **on `approve`**:
  1. finds the post through `content_items.approval_id`, a foreign key (trusted), not through anything the caller supplies;
  2. refuses if the approval's `meta.postId` names a different post;
  3. applies the claim rules to the approval's title and text **and** to the linked post's title, topic, caption, hashtags, creative brief and image direction;
  4. does so for any approval that is linked to a post **or** has `generated_by = 'content'` **or** `type = 'Content'`.
  Rejecting is never blocked by claims, and rejecting is also possible when the post has moved on (section 7, F3). Non-content approvals (for example a B2C reply that quotes a price) are not touched.
- **Text is normalised before the rules run (F1)**, in the database (`private.normalize_claim_text`) and in the application (`normalizeClaimText`), in the same order:
  Unicode NFKD, drop combining accents, NFKC (fullwidth characters, no-break and other special spaces become plain), Cyrillic/Greek look-alike letters become Latin,
  invisible characters (soft hyphen, zero-width space/joiner, word joiner, BOM) are removed, every dash becomes `-`, and any whitespace run (including line breaks) becomes one space.
  A test fails if the two copies drift, and a second test checks that the database and the application produce identical normalised text, including for Devanagari, Tamil, Japanese and accented Latin copy.
- `submit_content()` applies the same rules before it creates the approval, so a draft with prohibited wording is refused at submission as well.
- **No approved-claims input.** `approvals.meta.allowedClaims` is written by users (writers can insert approvals), so the database ignores it entirely. The application now
  ignores it too (it passes none), so both sides agree. Until a trusted source of client-approved claims exists, every rule applies in full. This matches how live content already behaved
  (the application always sent an empty list when it created live approvals).
- A writer can no longer insert an approval carrying `allowedClaims`, `postId` or `kind = content_draft` (trigger `approvals_meta_guard`), so that metadata cannot be forged.

### Differences between the application and SQL checks (documented, deliberate or unavoidable)
| Difference | Effect |
|---|---|
| SQL word boundary is `\y`; in Postgres `\b` means "backspace". The migration text is the JavaScript pattern with `\b` replaced by `\y`; a test fails if they drift. | None on behaviour for the tested phrases. |
| Postgres picks the **longest** alternative; JavaScript picks the **first**. | The matched text could in theory be longer in SQL. Whether a rule fires is the same. In the 200+ phrase/case comparisons run, matches were identical. |
| "Word" characters follow the database locale rather than JavaScript's ASCII `\w`. | Possible edge differences next to accented letters; not observed in tests. |
| The database also scans the linked post's own fields, not only the approval text. | Strictly stricter, and closes a gap where the approval text is benign but the post is not. The post's fields are the source of the approval text, so ordinary posts are unaffected. |
| The application check is only an early answer with details (it returns the matched phrases). The database repeats it and is authoritative. | A direct call gets the database's refusal: `prohibited claims: <label>: "<text>" | ...`, mapped by the app to the same `422`. |
| Post **titles and topics** are now scanned by both sides (F6): at submission, and at approval together with the approval's own title. | Stricter than before. A live post titled like a claim ("Best sellers", "100% guaranteed") is refused. |
| The matched text reported by both sides is the **normalised** text (F1). | A look-alike spelling is reported in its plain form. |
| The rules still list their phrases literally. Normalisation closes character-level tricks (spaces, dashes, invisible characters, look-alike letters), **not** misspellings or paraphrases ("w4terproof", "100 percent", "guarantee-d"). | The guard prevents accidental and trivially disguised claims; it is not a defence against a writer who deliberately rewords. Say so to the client. |

---

## 2. S2 — approved content cannot be changed around the workflow

### What was built
- **Trigger `content_items_guard`** (applies to signed-in API callers only; the SQL editor, the service role and the privileged functions pass):
  - `status` and `approval_id` cannot be changed directly, by anyone.
  - While a post is `pending_approval`, `approved` or `published`, its `platform`, `title`, `topic`, `caption`, `hashtags`, `creative_brief` and `image_direction` cannot be changed.
    The planned date (`scheduled_for`) can still be moved. Drafts and rejected posts stay editable.
  - `id`, `org_id`, `created_at` and `created_by` cannot be changed.
- **Insert rule:** a new post must be a draft with no approval (`content_items_insert` policy tightened with `alter policy`), so nobody can insert a row that already looks approved.
- **Controlled functions** (SECURITY DEFINER, `search_path` fixed, execute for signed-in users only, never anonymous), each re-checking membership and role because they bypass RLS:
  - `submit_content(post)` — draft → pending. In one transaction: checks role, draft state and caption; **builds the approval text and metadata itself** (same layout as `renderPostForApproval`);
    applies the claim rules; creates the approval with `meta.postId`; links it; writes an `agent_activity` row with the real actor.
  - `decide_approval(...)` — as in S1, and also sets the post to `approved` or `rejected` **in the same transaction**. It refuses to **approve** if the post is not waiting for approval or the metadata names another post
    (in those cases **rejecting** still works and changes only the approval, never the post: F3). It **refuses to edit** the approval of a post (F4): the approval is the record of exactly what the post said when it
    was submitted, and the post is locked while it waits, so the approved text always equals the post. To change wording: reject, reopen, edit, submit again. Edits remain possible for approvals that do not belong to a post.
  - `reopen_content(post)` — back to a draft with no approval, only where legitimate: a rejected post (any writer), a pending post with no pending approval behind it (any writer),
    an approved or published post (owner, admin or approver only; it must be approved again). A post waiting for a decision cannot be reopened. Writes an `agent_activity` row.
- **Metadata cannot be forged:** direct inserts may not carry `postId`, `allowedClaims` or `kind = content_draft`; `submit_content` writes them; `decide_approval` re-checks `meta.postId` against the linked post.
- **Atomicity.** Each function is one transaction. Any failure (prohibited claim, constraint, role) rolls back the whole step: no half-submitted post, no orphan approval, no status change without an audit row.

### Application changes (needed because the database no longer accepts direct status writes)
- `src/services/live.ts`: submit is one `submit_content` call; editing a rejected (or stuck pending) post calls `reopen_content` first, then updates the wording only; deciding is
  only the `decide_approval` call (the best-effort status sync is gone, the database does it); the compensating undo of the old multi-step submit was removed because it can no longer be needed.
- `src/lib/content-agent/claims.ts`: exports `CLAIM_RULES` (read-only view) so a test can prove the SQL copy has not drifted. The rules themselves are unchanged.
- Demo behaviour is unchanged: the demo uses the in-memory sample store, which never calls these functions.

### Review of the old orphan-approval handling
The old flow ran three separate writes (claim the draft, insert an approval, link it) and, on failure, tried to put the post back and reject the unlinked approval, which staff could not do.
That left possible pending approvals that no post pointed to. It is replaced by one atomic function, so the failure mode cannot occur. Orphan approvals already created by the old flow (none are
known to exist on any hosted database) remain pending rows that approve nothing; the database refuses to approve a linked approval whose `postId` does not match.

### Audit
- Decisions: `audit_log` row written by `decide_approval` (unchanged, append-only).
- Submit and reopen: `agent_activity` rows (append-only) with the real signed-in user. Since F5 the `agent_activity_insert` policy no longer lets a writer insert rows whose `ref_type` is `content_item` or
  `approval`, so any row that points at a post or an approval was written by `submit_content` / `reopen_content`, not typed by a user. (Ordinary activity without a reference is unchanged; a writer can still add
  free-text lines about themselves, which carry no reference to a post.) Withdrawing an approved or published post is recorded with the words "it had been approved/published and needs approval again". `audit_log` itself is not extended because its `action` check allows only approve, reject and edit and altering that would be a further schema change.

---

## 3. Migration contents (`20261104000000_security_hardening.sql`)
Wrapped in `begin; ... commit;`.
0. `private.normalize_claim_text(text)` (immutable, `search_path = ''`, execute revoked like the helper below).
1. `private.find_prohibited_claims(text)` (immutable, `search_path = ''`, normalises its input first), execute revoked from public, anon and authenticated.
2. `private.content_items_guard()` + trigger `content_items_guard` (before update).
3. `alter policy content_items_insert` (adds `status = 'draft' and approval_id is null`; the role and tenant checks are kept) and `alter policy agent_activity_insert`
   (adds: `ref_type` may not be `content_item` or `approval`; the role, tenant and actor checks are kept).
4. `private.approvals_meta_guard()` + trigger `approvals_meta_guard` (before insert).
5. `public.submit_content(uuid)`, `public.reopen_content(uuid)`; `create or replace` of `public.decide_approval(...)` (same signature).
6. Grants: all three public functions revoked from public and anon, granted to authenticated.
7. Review follow-ups: `private.content_items_set_creator()` + trigger (before insert, F15); unique partial index `content_items_approval_id_key` on `content_items (approval_id)` (F10);
   `private.content_items_log_delete()` + trigger (after delete, F11); the content guard now locks every column except the planned date (F9); every approval is claim-scanned, not only content ones (F2).

The only schema addition is the one unique index (F10). It fails to apply if two posts already share an approval, which is why `docs/security_hardening_preapply_audit.sql` (query A3) must be run first. No existing policies other than the two `alter policy` statements, and no data, are changed. Nothing is deleted by the migration. Existing RLS and organisation isolation are unchanged.

## 4. Tests added (all local; none hosted)
| File | Kind | Count | Covers |
|---|---|---|---|
| `tests/security-hardening.test.ts` | in-process Postgres, real migrations | 66 | SQL/JS rule drift; 200+ phrase/case parity; **19 look-alike spellings caught identically by both sides, normaliser parity and no false alarms for Devanagari/Tamil/Japanese/accented copy, drift of the normalisation steps (F1); stranded approvals can be rejected but not approved (F3); an approval of a post cannot be edited and the approved text equals the post (F4); activity that points at a post cannot be forged, real history is written (F5); title/topic/approval-title scanned (F6); the 6000-character boundary and a clear message (F12)**; direct `decide_approval` calls with prohibited wording, case variations, forged allowlist, edited (unlinked) approval text, post fields, reject allowed, non-content approvals not blocked; role matrix (owner, admin, approver, staff, viewer, stranger, visitor, other organisation); locked content for staff and owner in each locked state; status and link writes denied; insert-as-approved denied; submit/reopen/resubmit workflow; forged and mismatched metadata; failed steps leave no change; audit and activity rows; function privileges |
| `tests/security-hardening-script.test.ts` | in-process Postgres | 1 | `docs/security_hardening_live_check.sql` (the staging script: 81 checks, of which 30 are new for the review fixes) runs end to end and every check passes; leaves no data |
| `tests/live-data.test.ts` (updated) | fake client | 9 rewritten, 4 added, then 6 more for the review fixes | the app never writes status or approval links itself; submit is one call; refusals mapped (404, 409, 422 with details, 403); allowlist in metadata ignored; reopen-then-edit; the old multi-step undo tests replaced |
Mutation check: removing the claim check, the content trigger, the metadata check or the insert rule each makes tests fail. For the review fixes, each of these was undone in turn and the tests failed every time:
the normaliser (3 tests fail), the reject rule for stranded approvals (3), the edit refusal (2), the narrowed activity policy (2), the title/topic scan at submit (2), the approval-title scan at approval (2), and the length check (3).
**Not covered locally:** true concurrent sessions (one connection) — see `docs/STAGING_SETUP_AND_VERIFICATION.md` section 7.

## 5. Remaining limitations and risks
- **Not applied anywhere.** Until it is applied to staging and the staging scripts pass, the hosted behaviour is unverified. The existing hosted project still has the old `decide_approval()`; the new app code
  calls `submit_content` and `reopen_content`, so **the app and the migration must be deployed together** (live submit and edit of social posts fail against a database without the migration).
- **Postgres regex dialect** differs from JavaScript in the ways listed in section 1; parity was tested for a broad phrase set, not exhaustively.
- **No trusted approved-claims source.** Every claim rule applies in full for live content. A real allowed-claims mechanism (client-approved, stored by an administrator) is a later schema decision and is not in the frozen scope.
- **Owner/admin can still delete a post** (delete policy unchanged, by instruction). Deletion removes content; it does not approve anything. Since F11 every deletion is recorded in `agent_activity` with the person who did it.
- **Approver edits** of an approval that belongs to a post are refused (F4). Edits of approvals that do not belong to a post remain; the claim check runs on the edited text at approval, and since F2 it runs for every approval whatever its type. Nothing is published by the application, so what a person later posts by hand is outside the system.
- **Rows created before the migration** (a post already set to approved by hand, or approvals without `meta.postId`) are not rewritten; run `docs/security_hardening_preapply_audit.sql` first on any database that holds data (F7). They show as drafts in the app (approval-backed rule) and a staff member needs an approver to reopen an approved one.
- `agent_activity` is the audit trail for submit and reopen; `audit_log` still covers decisions only.
- Sign-ups on the existing project (last seen ON), and the unverified behind-domain CSRF check, are unchanged and remain the owner's/M7 items.
- This report and the migration are **not reviewed by the project owner yet**.

## 6. Rollback considerations and recovery
The migration changes no data and no tables, so it can be removed without data loss. Rollback restores the foundation behaviour (the old, application-only claim check and direct status writes).
**Roll back the application first** (deploy the previous commit), because the new app calls functions that the rollback removes. Then, in the SQL editor (administrator), only on the affected project:

```sql
begin;
drop trigger if exists content_items_guard on public.content_items;
drop trigger if exists approvals_meta_guard on public.approvals;
drop trigger if exists content_items_set_creator on public.content_items;
drop trigger if exists content_items_log_delete on public.content_items;
drop index if exists public.content_items_approval_id_key;
drop function if exists private.content_items_set_creator();
drop function if exists private.content_items_log_delete();
drop function if exists private.content_items_guard();
drop function if exists private.approvals_meta_guard();
drop function if exists public.submit_content(uuid);
drop function if exists public.reopen_content(uuid);
drop function if exists private.find_prohibited_claims(text);
drop function if exists private.normalize_claim_text(text);
alter policy content_items_insert on public.content_items with check (private.can_write(org_id));
alter policy agent_activity_insert on public.agent_activity
  with check (private.can_write(org_id) and actor_id is not distinct from (select auth.uid()));
-- restore the foundation decide_approval(): re-run its "create or replace function public.decide_approval" block
-- from supabase/migrations/20261101000000_foundation.sql (lines for the function and its grants), unchanged.
commit;
```

Recovery after a mid-flight problem: the functions are atomic, so there is no partial state to repair. Posts that were approved under the new workflow stay approved; their approvals remain as history.
Take a database backup (staging: not needed; production: required) before applying or rolling back. Re-running the migration after a rollback is safe (it uses `create or replace` and recreates the triggers).
The rollback block above was executed locally exactly as written, followed by the foundation `decide_approval()` block: no hardening object, trigger or changed policy remained, and the migration applied again cleanly afterwards.
**Ordering and the compatibility window (review finding F8).** The app and the migration depend on each other in both directions, so a rollback has a short window in which posts cannot be submitted or edited:
- New app + old database: `submit_content` and `reopen_content` do not exist, so submit and reopen fail (clear error, nothing is written).
- Old app + new database: the old app writes `status` and `approval_id` directly, which the content guard refuses, so submit and edit of social posts fail (clear error, nothing is written).
Sequence for a rollback: (1) announce a short pause for social posts and approvals, (2) deploy the previous app commit, (3) run the rollback SQL above straight after, (4) confirm a draft can be created, edited and submitted. For a roll-forward, do the reverse: apply the migration, then deploy the app within minutes.
Nothing is corrupted in either window; the cost is a few minutes in which social post submit and edit fail. Sign-in, customers, retailers, products, tasks, orders and reports are unaffected throughout.

## 7. Independent security review: what changed and what did not

An adversarial review of the first version found no way for a signed-in user to change status, the approval link or locked wording directly, or to forge an approval-to-post link.
It found six weaknesses that were approved for fixing, and others that were not.

**Fixed in this version** (each has database tests, app tests where the app is involved, checks in `docs/security_hardening_live_check.sql`, and was confirmed by undoing the fix and watching tests fail):

| Finding | Problem | Fix |
|---|---|---|
| F1 | The claim rules could be evaded with no-break spaces (the app and database even disagreed), zero-width characters, other dash characters, fullwidth or look-alike letters, accents and line breaks. | Text is normalised the same way in both places before the rules run (section 1). |
| F3 | An approval linked to a post that was no longer waiting could be neither approved nor rejected, so it stuck in the queue. | Rejecting is always possible and changes only the approval; approving still needs a consistent post. |
| F4 | An approver could edit the approval text of a post and then approve it, so the approved text differed from the stored post. | Editing the approval of a post is refused; reject, reopen, edit and submit again. Approvals that do not belong to a post can still be edited. App: HTTP 409 with a plain message. |
| F5 | Any writer could insert "reopened"/"submitted" activity rows for a post, so that history could be forged. | The `agent_activity_insert` policy no longer accepts `ref_type` of `content_item` or `approval`. Withdrawing an approved post is recorded as such. |
| F6 | The title and topic were not scanned (a post titled "100% guaranteed waterproof" went through). | Both are scanned at submission; at approval the post's title and topic and the approval's title are scanned too. App: same early check. |
| F12 | A post whose preview exceeded the approval limit (many hashtags) failed on a table check with the same error code as a claims refusal. | A clear refusal ("too long to send for approval", limit 6000) from the database, and an early message in the app. |

**Fixed in the second pass** (database tests, app tests where relevant, 8 more checks in the staging script, and mutation-checked: each fix undone, tests fail):

| Finding | Problem | Fix |
|---|---|---|
| F2 | The claim rules applied only to approvals that looked like content; type and generator are chosen by whoever inserts an approval. | `decide_approval` now scans every approval it approves, whatever its type. The app's early check does the same. Rejecting is unaffected. **Consequence:** a non-content approval (for example a retailer message) that contains a price, an offer, a stock or material claim now needs its wording changed before it can be approved. There is still no trusted allowed-claims list. |
| F9 | The locked wording was a list of columns, so a column added later would have been left open. | The guard compares the whole row except the planned date, so new columns are locked by default. The planned date stays editable on purpose (calendar planning). |
| F10 | One approval could be linked to two posts (no unique index). | Unique partial index on `content_items (approval_id)`. The migration fails to apply if existing data already breaks this; the audit file finds it first. |
| F11 | Owner or admin deletion of a post left no trace. | A delete trigger writes an `agent_activity` row with the person and the status the post had. Skipped when a whole organisation is deleted. |
| F15 | The creator of a new post could be set by the writer. | A before-insert trigger records the signed-in caller, whatever the request sends. |
| F7 | Rows that existed before the migration were not revalidated. | Not auto-repaired (that would rewrite data). New read-only `docs/security_hardening_preapply_audit.sql` finds them; run it before applying to any database with data. |
| F8 | Rollback ordering. | Documented sequence and the exact failure window (section 6). No data corruption is possible in either window. |

**Still open** (cannot be closed from code alone):
- F10, concurrency: true simultaneous sessions are still not tested locally (one connection). Row locks and the new unique index make the outcome safe by design; the two-session check in `docs/STAGING_SETUP_AND_VERIFICATION.md` section 7 is the proof and is NOT RUN.
- F13, F14: ownership of the definer functions and `begin/commit` under the Supabase CLI can only be confirmed on a real staging project.
- F2 (residual): no trusted source of client-approved claims exists, so the rules are absolute. That needs a client decision and a schema change, and is not in the frozen scope.
- The activity table still allows free-text lines without a reference; only rows that point at a post or an approval are reserved.

**Side effect on the demo.** The shared claim check (`findProhibitedClaims`) now normalises text, so the demo's own guard also catches the disguised spellings and now sees phrases split across line breaks or extra spaces.
This only makes the guard stricter for exotic text; the demo's sample data, screens and tests are unchanged (all demo tests pass).
