# Google Maps B2B prospecting: Phase 1 database schema proposal, version 2

**Status: PROPOSAL ONLY (version 2).** Nothing here is a migration file, nothing has been applied, and no existing table, column, policy, grant or function is changed. The only touch on an existing table is one optional trigger in Migration X, which you approved in principle (O1) and which is applied only on a separate, explicit go-ahead. Date: 2026-11-16. Branch `feature/client-delivery`.

Supersedes version 1 of this document. Applies your approval of decisions O1 to O25 and the decision closure of O26 and O27 (section 4.6 and section 4.8; accepted as the design baseline, 2026-11-16) in `docs/GOOGLE_MAPS_B2B_SECURITY_REVIEW.md` (read that for the reasoning behind each change). Builds on the specification (`docs/GOOGLE_MAPS_B2B_LEAD_GENERATION.md`, revision 2) and the Phase 0 readiness document.

> **R1 (legal clearance on Google Maps terms and personal-data retention) remains a hard blocker before any of this is implemented.** This document may be reviewed freely; it must not become a migration until R1 is cleared and you approve it.

**What was and was not verified.** The SQL in sections 15 to 18 was run in a scratch in-process Postgres (PGlite, outside the repository) on top of the real foundation and Amazon migrations: **273 checks pass, 0 fail** (256 in the main run plus 17 migration-dependency and partial-rollback checks). Eleven deliberate mutations of the SQL (demonstration gate, caller-side cost, cache read policy, automatic-outcome guard, approvals trigger, draft-hash binding, key-version loop, fail-closed key, owner-only settings, single-use approval, suppression check in the outreach guard) were each detected. The rollback removes every new object and the existing tables, policies and triggers are identical before and after. **This proves the SQL and its policies in PGlite. It does not prove hosted Supabase behaviour.** Specifically unverified until M1 staging: Supabase Vault (`vault.decrypted_secrets`, which the harness replaces with a plain table), `pgcrypto` in the `extensions` schema (the harness installs it there), `pg_cron`, Realtime exclusion, real Auth claims, backup retention, and **concurrent reservations** (PGlite has one connection, so the locking argument is reasoned, not run). The SQL in this document is generated from the very files the checks ran on (including the pre-flight checks in section 10).

---

## 1. What changed from version 1

| Area | Version 1 | Version 2 | Decision |
|---|---|---|---|
| Demonstration organisations | Not checked in the database | `private.prospect_org_live()` in every write policy and every function; reserve returns `demo` | O4 |
| Settings, caps, prices | Admin could raise own caps | Settings **owner-only**; prices stored; stop switch via function (any admin stops, **only the owner resumes**) | O7 |
| Cost of a request | Supplied by the caller (0 bypassed the cap) | **Computed by the database** from stored prices; no cost parameter | O7 |
| Reservation | Returned text | Returns status, ledger id and cost; unit must belong to the campaign | O7 |
| Automatic outcomes | Freely editable | State machine: hard-fact rejection and duplicate verdict are final; decided candidates cannot be re-scored | N3 |
| Candidate deletion | Admin could delete | No delete grant; rows leave only via purge or erase | O19 |
| Cache read | Any member, expired rows too | **Approver and above, fresh rows only**, live organisations only | O8 |
| Provenance writes | Direct insert allowed | **Only the two functions**; `source_reference` 8 to 300 characters | O20 |
| Fingerprints, suppression | Unkeyed SHA-256, app-computed | **HMAC-SHA256 computed in the database**, keys in Vault, purpose-separated, versioned | O5, O6 |
| Suppression enforcement | Application only | Enforced in the new tables, and (Migration X) on `approvals` marked `prospect_outreach` | O1 |
| Draft text | Would sit in approvals | `prospect_outreach_drafts` (deletable); approval holds a shell and a draft hash | O10 |
| Outreach | Six invented states, one row per channel | **FR12's eight states**, one row per attempt, transition table, single-use approval bound to the draft hash | O15, O23 |
| Erasure | Procedure only | `erase_prospect_retailer()` suppresses first, redacts approvals, deletes | O13 |
| Purge | One function, one transaction | Two independent steps, bounded batches, logged in `prospect_purge_runs`, `prospect_purge_status()` | O18, O22 |
| Acceptance | No duplicate-retailer check | Refuses a retailer with the same phone, email or website host unless a person confirms | O21 |
| Tables | 9 + 2 | **10 + 3** (adds `prospect_purge_runs`, `prospect_outreach_drafts`) | O10, O18 |

**Decisions with no schema effect, recorded as approved:** O11 (a separate code task changes existing retailer logging to ids), O12 (no change to `decide_approval()`; a UI rule instead), O14 (native-speaker review of the Hindi and Hinglish lists), O16 (no sightings table), O17 (concurrency tested on staging only, no new dependency), O24 (`pg_cron` only after staging verification and R2), O25 (the stated limits are acknowledged: the database cannot stop off-system messaging, cannot recompute scores, and cannot protect against its own administrator). O2 (do **not** restrict who may insert approvals) and O3 (**no** suppression removal path in version 1) are honoured by omission.

---

## 2. Corrections to the specification (unchanged in substance)

Both are also applied to `docs/GOOGLE_MAPS_B2B_LEAD_GENERATION.md`.

### 2.1 Section 6.6: what erasure can and cannot do

`agent_activity` and `audit_log` are append-only by trigger. `approvals` has no deletion path for any role, and its `title` (200), `preview` (6,000) and `meta` can hold personal or business details. Existing code writes business names permanently into activity text. **Version 2 mitigation:** prospecting writes only ids and fixed text; approvals for prospecting hold only a shell title and preview plus `{kind, ref, draft_id, draft_sha256}`; the draft text lives in `prospect_outreach_drafts` and goes with the retailer; `erase_prospect_retailer()` suppresses first, redacts every approval pointing at the retailer (the row and its status remain), then deletes. **Still not erasable by the application:** existing `agent_activity` and `audit_log` rows, and approvals created before this work that do not point at a retailer by `meta.ref`. That is a manual, owner-run, counsel-approved procedure outside the application. Unresolved under R1: L2, L3, L12.

### 2.2 FR13: suppression enforcement, now bounded precisely

Version 2 makes suppression **database-enforced for everything routed through the system**: a `prospect_outreach` row cannot be created, nor move to pending approval, approved or contacted, for a suppressed retailer; and (Migration X, optional) an `approvals` row marked `prospect_outreach` cannot be created or approved for one. **Not covered, stated plainly:** an approval created without the `prospect_outreach` marker (the approvals insert policy is unchanged, O2), and any message a person sends outside the system. The suppression check **fails closed**: if the key is missing, the operation is refused, not skipped.

---

## 3. The thirteen tables

| # | Table | Migration | Class | Purpose |
|---|---|---|---|---|
| 1 | `prospect_settings` | A | P | One row per organisation, created by the **owner**: caps (zero by default), prices (assumed, top tier), retention, scoring version, stop switch |
| 2 | `prospect_categories` | A | P | Search terms (no signal words; those live in versioned code) |
| 3 | `prospect_locations` | A | P | Cities with `is_expansion`, `tier`, optional centre and radius |
| 4 | `prospect_campaigns` | A | P | Definition, caps, atomic counters (not directly writable) |
| 5 | `prospect_search_units` | A | P (+ transient token) | Term by city progress; page token cleared when a unit ends |
| 6 | `prospect_candidates` | A | P | One row per Place ID; `auto_*` separate from `review_*`; duplicate references to candidate or retailer; no delete |
| 7 | `prospect_place_cache` | A | **G** | The only place Google content is stored; 30-day ceiling; approver-only, fresh-only read |
| 8 | `retailer_contact_sources` | A | P | Field-level provenance with a keyed fingerprint and key version |
| 9 | `prospect_usage` | A | P | Append-only reservation ledger with organisation, campaign, unit, tier, database-computed cost, price basis |
| 10 | `prospect_purge_runs` | A | operational | Append-only, content-free purge log (counts and SQLSTATE only) |
| 11 | `prospect_suppressions` | B | P | Keyed hashes only; append-only; no removal path |
| 12 | `prospect_outreach_drafts` | B | P | Draft text, hashed by a trigger, never edited |
| 13 | `prospect_outreach` | B | P | One row per attempt; FR12's eight states |

Class G data exists in exactly two places: `prospect_place_cache` and `prospect_search_units.page_token`.

### Entity-relationship diagram

```
organizations (existing, has is_demo)
   |---- prospect_settings (1 row per org, owner-created)
   |---- prospect_categories *     prospect_locations *
   |---- prospect_campaigns * --1--* prospect_search_units *  (category, location FKs; page_token = class G)
   |        |---- prospect_candidates * <--- (campaign FK)
   |        |         |  self: duplicate_of_candidate_id
   |        |         |  duplicate_of_retailer_id ------> retailers (existing)
   |        |         |  retailer_id (set on accept) ----> retailers (existing)
   |        |         |---- prospect_place_cache (0..1)  CLASS G, <= 30 days, approver-only, fresh-only
   |        |---- prospect_usage * (append-only; also -> unit)
   |
   |---- retailers (existing) --1--*-- retailer_contact_sources --(optional)--> prospect_candidates
   |         |---- leads (existing; created by accept_prospect_candidate at stage 'new')
   |         |---- prospect_outreach_drafts *  [B]
   |         |---- prospect_outreach *  [B] --(draft)--> prospect_outreach_drafts, --(approval)--> approvals (existing)
   |
   |---- prospect_suppressions * [B]  keyed hashes, no FK to retailers (survives erasure)
prospect_purge_runs  (global, not tenant data; API roles cannot read it)

approvals (existing) <-- ONE trigger (Migration X, optional): suppression guard for meta.kind = 'prospect_outreach'
```

Every foreign key between tenant tables is composite `(org_id, id)`. Existing tables are only referenced, never altered (the one trigger in X aside).

---

## 4. Security design

### 4.1 Demonstration organisations and the owner
`private.prospect_org_live(org)` is true only when the organisation exists and `is_demo` is false. It sits in the `with check` of every insert and update policy and as an early refusal in every function. A demonstration organisation can hold no prospecting data and spend nothing. `private.is_owner(org)` (built on the foundation's `role_in`) gates settings, prices and resuming after an emergency stop.

### 4.2 Spend control
`reserve_prospect_request(campaign, operation, tier, unit)` has **no cost parameter**. It locks settings then campaign, checks stop-all, campaign state and caps, computes the cost from the stored price for the operation, increments the counters and appends the ledger row, returning `status`, `usage_id` and `cost_usd`. Statuses: `ok`, `demo`, `no_settings`, `stopped`, `campaign_not_running`, `cap_reached`. A missing settings row means "no", and caps ship at zero. Any admin can stop (`set_prospect_stop`); only the owner can resume. A failing request still counts (reserved before the call, per attempt).

### 4.3 Keyed hashing and the secret store
- All secret access goes through one function pair, `private.prospect_key_versions(purpose)` and `private.prospect_key(purpose, version)`. In the hosted project these read Vault secrets named `prospect_<purpose>_v<version>` (`suppression` and `provenance` are separate keys). **A missing or short (under 32 characters) key raises: callers fail closed.**
- `private.prospect_normalise(kind, value)` is the **single** implementation of normalisation (phone to last ten digits, email lower-cased, website host, Instagram handle, whitespace-collapsed text), so the application and database cannot disagree.
- `private.prospect_hmac(purpose, version, kind, value)` is HMAC-SHA256 over `kind:normalised value` (the kind separates domains), hex-encoded. Provenance fingerprints store the **key version** with each row, so old rows keep verifying after rotation.
- **Rotation, honestly.** A hash cannot be re-hashed. Adding a key version affects new rows only; old versions stay active for as long as rows under them exist, and the check hashes under **every** version. A leaked key means every hash under it must be treated as exposed. The key and the hashes live in the same database, so this protects against dumps and exports, **not against the database owner**.
- **Plaintext crosses to the database** (over TLS) when a person adds a manual suppression. Statement logging must not capture parameters (to be checked on staging).
- The owner creates the Vault secrets **before** applying the migrations; the migrations never create, read out or log a key. Custody, generation, backup, rotation and compromise handling are decided in section 4.8 (O27).

### 4.4 Google cache access
Read policy: `can_decide(org) and expires_at > now() and prospect_org_live(org)`. Staff and viewers never see Google content; expired rows are invisible whether or not the purge runs. `address_components` is size-limited. The table must not be in the Realtime publication (verified on staging, test T-E10). Hosted backups still hold expired rows past 30 days (L11).

### 4.5 Candidates
Automatic outcomes follow a trigger state machine: a `rejected_hard_fact` or `duplicate` result is final, and a decided candidate cannot be re-scored. A person's undo of a fuzzy duplicate is recorded in `review_decision`, not by rewriting the automatic verdict (acceptance then proceeds). **Consequence to accept:** a place rejected on a hard fact (for example "outside configured locations") stays rejected even if locations later expand; reconsidering would be a manual procedure. The database also **cannot recompute a score**: it trusts the application, and an admin acting through the API could write a forged score. That is the limit O25 acknowledges.

### 4.6 Suppression, opt-out and erasure
- `retailer_is_suppressed(org, retailer)` hashes the retailer's **current** email, phone, website host and Instagram handle under every active key version. It is the one implementation used by the outreach guard, the opt-out and erase functions, the UI helper and the Migration X trigger.
- `add_prospect_suppression` (approver and above) suppresses a value that is not a retailer. `record_prospect_opt_out` (any writer) suppresses **every** identifier a retailer has, closes every open attempt, and records an opted-out row, in one transaction. `erase_prospect_retailer` (owner or admin) suppresses first, redacts approvals pointing at the retailer (`meta.ref`), then deletes the retailer; it **raises and deletes nothing if the key is missing**.
- **Known residual risk (decision O26, decided):** the existing `retailers` delete policy lets an owner or admin delete a retailer directly through the existing CRM permissions, which skips suppression-before-delete. **No trigger is added to `retailers`, and no existing retailer policy, grant or permission is changed**; changing them needs separate explicit approval. What this design guarantees instead: (a) nothing created by prospecting grants or policies a delete on `retailers` (tested: the privilege and policy snapshots of `retailers` are identical before and after, and no trigger exists on it); (b) exactly one function in the new SQL contains `delete from public.retailers`, `erase_prospect_retailer()`, and a test fails if a second appears; (c) every prospecting-related deletion (erasure on request, removal of a prospect that turns out to be unwanted) must use `erase_prospect_retailer()`, which suppresses first and refuses if the key is missing; (d) the application must never call a direct retailer delete from any prospecting screen or job (a source-guard test is part of the code work, section 13). The risk that remains is a person with admin rights deleting a retailer in the ordinary CRM and then re-adding or contacting the same person: that is a procedural control (staff guidance), not a database one. Re-open O26 only if counsel (L4, L12) says the database must prevent it.
- **Editing a retailer's email after suppression** means the new email is not suppressed; the old hash remains. Documented behaviour (test T-U5).

### 4.7 Outreach
`prospect_outreach_guard` enforces: a new attempt starts as drafted (the API has no insert privilege on `status`); attempt numbers are assigned by the database; nothing is created for a retailer that has opted out; statuses move only along the transition table; `opted_out` is reachable from every open state and is final; entering pending approval, approved or contacted requires the retailer **not suppressed**, an approval for this retailer of kind `prospect_outreach` in the right state, and a draft of this retailer and channel whose hash equals the approval's `meta.draft_sha256`; contacted also requires a recorded independent source and stamps `contacted_at`. An approval authorises exactly one attempt (unique index), the approval and draft cannot be swapped once set, and there is at most one open attempt per retailer and channel. Staff may create drafts and attempts; approvers approve (O23). "Contacted" is recorded by a person after sending manually; nothing is ever sent.

---

### 4.8 Key custody, rotation and recovery (decision O27, decided)

**Who controls the keys.** The production suppression and provenance keys are controlled by the Cheri & Co. / VEDASRI owner. No developer, no application server process other than the database, and no AI assistant holds a key value or sees one at any time.

**Requirements (all binding on implementation):**
1. **Two independent keys.** Suppression and provenance each have their own key, generated separately. Neither is derived from the other, from a password, or from any other secret. Each is at least 32 characters from a cryptographically secure random source (for example 32 random bytes, base64 or hex encoded); the database refuses anything shorter.
2. **Stored in Supabase Vault** as `prospect_suppression_v<N>` and `prospect_provenance_v<N>`, and nowhere else: not in a table column, a migration, an Edge Function secret, an `.env` file, or a Supabase project setting.
3. **Access only through approved database functions.** Only `private.prospect_key_versions()` and `private.prospect_key()` read Vault. They are in the `private` schema, with execute revoked from `public`, `anon`, `authenticated` and `service_role` (tested). No application role can select from `vault.decrypted_secrets` through anything this design adds.
4. **Versioned.** A key is never edited in place. A new version is a new secret with the next number.
5. **Fail closed.** A missing, empty or short key raises `key unavailable` (SQLSTATE 55000). Erasure, opt-out, suppression checks, acceptance and the outreach guard all raise and change nothing (tested and mutation-checked). Pre-flight checks also stop Migrations A and B from being applied before the owner has created version 1 (section 10).
6. **No secrets in code, Git, prompts or ordinary environment files.** Key values never appear in source, migrations, tests, documents, commits, logs, chat or Claude prompts, and are not placed in `.env`, `.env.example` or any ordinary environment file. The scratch tests use throw-away strings labelled as test-only, never reused anywhere.

**Generation, backup and recovery responsibilities**

| Step | Responsible | Notes |
|---|---|---|
| Generate each key | Owner, on their own machine, with a cryptographically secure generator | Never in a third-party web tool, never by an assistant |
| Enter into Vault | Owner, in the Supabase dashboard (SQL editor or Vault UI) of the target project, staging first | The owner types or pastes it themselves; only the secret's name is ever shared |
| Offline backup | Owner | At least one copy in the owner's own secure store (an offline password manager entry or sealed paper copy), kept separately from the database backups, labelled by name and version only |
| Verify | Owner, with a second person present if possible | Create a test suppression, confirm the same value is recognised after a restore |
| Recovery of a lost Vault | Owner restores the secret from the offline backup under the same name and version **before** re-enabling prospecting | Until restored, the system fails closed |
| Consequence of losing the suppression key | Owner accepts in advance | Existing suppression hashes can no longer be matched; suppressed people could be contacted again and would have to be re-collected from the original opt-outs. **Loss of the suppression key without a backup is a compliance incident.** |
| Consequence of losing the provenance key | Owner accepts | Old fingerprints cannot be re-checked; affected rows are treated as unverified and re-attested by a person |

**Rotation procedure (owner-run, staging first):**
1. Generate a new key and store it as the next version (for example `prospect_suppression_v2`). Back it up first.
2. From that moment new suppressions and fingerprints use the highest version. Old versions stay active; nothing is re-hashed (a hash cannot be re-hashed).
3. **Backward compatibility for suppression:** every check hashes the value under **every active version** and matches against all stored hashes, so a person suppressed under v1 stays suppressed after v2 exists (tested). Provenance rows carry the version they were hashed under (tested).
4. **Never delete a key version that stored rows still use.** Before retiring any version the owner runs the read-only count of rows per key version (part of the staging runbook, not a schema change) and retires it only when the count is zero. For suppressions that normally means never, unless a person re-enters them under the new version.
5. Record the date and reason for each rotation in the owner's private log (not in Git).

**Compromise.** If a key is suspected exposed: stop prospecting (`set_prospect_stop`), create a new version, treat every hash under the exposed version as readable by the attacker (a hash of a phone number or email is guessable by brute force once the key is known), keep the old version active so suppressions still work, and record the incident. Counsel decides whether notification is needed (L12).

**Honest limits.** The keys and the hashes are in the same database project, so this protects against a stolen dump or export and against an application bug, **not against a person with full database-owner access**. Not verified locally and to be verified on hosted staging before production: how Vault encrypts and backs up secrets, whether a Supabase restore brings the secrets back, which schema `pgcrypto` lives in on the hosted project, and who in the Supabase organisation can read Vault. The local harness uses a plain table in place of Vault.

---

## 5. Provenance, acceptance and the existing-CRM path

`accept_prospect_candidate` is one transaction: role and state checks, demonstration refusal, the attestation, exactly one source per supplied value, a **duplicate-retailer check** (same phone, email or website host refuses unless the person passes the confirmation flag), the provenance key (missing key refuses and nothing is created), then retailer, lead at stage `new`, provenance rows with keyed fingerprints and key versions, the accepted decision, **deletion of the candidate's Google data**, and an id-only activity row. `attest_existing_retailer` is per retailer (no bulk form), uses the latest key version, writes an id-only activity row when it records anything, and is idempotent. `prospect_contact_status` is a definer function (it needs the key) that returns nothing unless the caller is a member of the retailer's organisation; an edited value shows as unsourced, a re-formatted phone does not. Provenance cannot be inserted directly by any API role.

**Honest limits.** Attestation is self-assertion; the database cannot prove a value was not first seen on Google. `existing_crm` can launder Google-derived values already in the CRM (mitigated by per-retailer calls, an audit row, a short review period, and an owner review report in the application). `source_reference` is free text and may itself hold personal data; it is bounded and deleted with the retailer. Erasing a retailer deletes its provenance.

---

## 6. RLS and privilege matrix

All tables: RLS on, `anon` and `authenticated` revoked first, then only the grants below. Roles: owner, admin (owner or admin = `is_admin`), approver (`can_decide`), staff (`can_write`), viewer. Another organisation's user has no access to anything. A demonstration organisation cannot write to any table.

| Table | viewer | staff | approver | admin | owner |
|---|---|---|---|---|---|
| `prospect_settings` | s | s | s | s | s i u (stop switch via function; resume owner only) |
| `prospect_categories`, `prospect_locations` | s | s | s | s i u d | s i u d |
| `prospect_campaigns` | s | s | s | s i u d (counters not writable) | same |
| `prospect_search_units` | s | s | s | s i u d | same |
| `prospect_candidates` | s | s | s | s i u (automatic columns only, state machine; **no delete**) | same |
| `prospect_place_cache` | none | none | s (fresh) | s (fresh) i u d | same |
| `retailer_contact_sources` | s | s | s u(review_after) | s u(review_after) d | same; **no insert** |
| `prospect_usage` | s | s | s | s (**no insert**) | same |
| `prospect_purge_runs` | none | none | none | none | none (read via `prospect_purge_status`) |
| `prospect_suppressions` | s | s | s | s (**no insert**; functions only) | same |
| `prospect_outreach_drafts` | s | s i | s i | s i | s i (no update, no delete) |
| `prospect_outreach` | s | s i u | s i u | s i u | s i u (no delete; rows go with the retailer) |

---

## 7. Database functions

| Function | Who | Purpose |
|---|---|---|
| `reserve_prospect_request(campaign, operation, tier, unit)` | admin | Atomic reservation; cost from stored prices; returns status, ledger id, cost |
| `set_prospect_stop(org, stop)` | admin stops; **owner resumes** | Emergency stop; id-only activity row |
| `accept_prospect_candidate(...)` | approver+ | Atomic acceptance (section 5) |
| `decide_prospect_candidate(candidate, decision, reason)` | approver+ | Reject, needs-more-info, undo a **fuzzy** duplicate; closed reason codes |
| `attest_existing_retailer(...)` | approver+ | Existing-CRM attestation |
| `prospect_contact_status(retailer)` | member | Value-changed marker and review due |
| `purge_prospect_expired(org)`, `purge_prospect_cache_now(org)` | admin | Lazy purge and "purge everything" |
| `prospect_purge_status(org)` | member | Last successful purge and an `overdue` flag |
| `add_prospect_suppression(org, kind, value, reason)` (B) | approver+ | Manual suppression |
| `record_prospect_opt_out(retailer, channel, reason)` (B) | writer | Suppress every identifier, close attempts |
| `erase_prospect_retailer(retailer)` (B) | admin | Suppress, redact approvals, delete |
| `prospect_retailer_suppressed(retailer)` (B) | member | UI helper; fails closed |
| **Private, no API execute grant:** key functions, `prospect_hmac`, `prospect_fingerprint`, `prospect_normalise`, `purge_expired_place_cache`, `run_prospect_housekeeping`, `retailer_is_suppressed`, `suppress_retailer`, the guard triggers | scheduler or triggers only | |

Every definer function: empty `search_path`, schema-qualified names, an explicit role check, a demonstration refusal, and the same "not found" for a missing row and another organisation's row.

---

## 8. Retention, purge and pg_cron

| Item | Mechanism |
|---|---|
| Cache ceiling | Database check: `expires_at <= fetched_at + interval '30 days'` |
| **Access after expiry** | **Blocked by the read policy immediately**, whether or not the purge runs |
| Deletion step 1 (critical) | `purge_expired_place_cache()`: bounded batches (5,000), its own transaction; a failure is logged with its SQLSTATE and returns -1 (never raises, so the log row survives) |
| Deletion step 2 (housekeeping) | `run_prospect_housekeeping()`: expires stale unreviewed candidates, deletes their Google data, clears page tokens older than a day; independent of step 1 |
| Lazy purge | The runner calls `purge_prospect_expired(org)` at the start of every prospecting request |
| Visibility | `prospect_purge_runs` (append-only) and `prospect_purge_status()`; the application shows "purge overdue" when an expired row is more than two hours past expiry |
| Schedule | **Two separate pg_cron jobs, one per step** (a single multi-statement job would be one transaction and re-couple them): hourly. A separate migration, only after staging verification and R2 (O24) |
| Backups | Expired rows persist in hosted backups and recovery (counsel, L11) |
| Organisation deletion | Blocked by the append-only ledgers, as `agent_activity` already is; a documented limitation |
| Monthly caps | Use the UTC calendar month; state it in the UI |

---

## 9. Remaining legal and policy decisions

The legal and policy decisions L1 to L12 are **still pending counsel and the owner**; nothing here decides them. The schema decisions O1 to O27 are all decided (O26 and O27 on 2026-11-16); the status of each remaining gate is in section 19.

| ID | Decision |
|---|---|
| **L1** | **R1 clearance** on Google's terms and on independence of attested human re-entry (hard blocker) |
| L2 | Is a sole trader's business name personal data? Is retained business-name text in append-only history acceptable? |
| L3 | Is the manual owner-run erasure procedure for existing history sufficient; is a retention limit on approvals needed? |
| L4 | Is keyed HMAC acceptable as the retained suppression form; who holds the keys; is the database-enforced scope (4.6, 4.7, X) sufficient? |
| L5 | Retention of suppressions after erasure, and recording the reason |
| L6 | Staff and viewers read **no** Google content (decided by O8); confirm counsel agrees |
| L7 | Trade directories stay off (R7) |
| L8 | Lawful basis and consent wording for first contact, WhatsApp in particular |
| L9 | Provenance fingerprints are now keyed (O6); confirm acceptable |
| L10 | Run `pg_cron` for the purge (R2), after staging verification |
| L11 | Backup and recovery retention against the 30-day ceiling |
| L12 | Is retaining keyed suppression hashes for people who asked to be forgotten lawful, and for how long |
| O26 | **Decided (2026-11-16):** no trigger on `retailers`; direct deletion through existing CRM permissions is a documented residual risk; prospecting deletes only through `erase_prospect_retailer()` (section 4.6) |
| O27 | **Decided (2026-11-16):** the Cheri & Co. / VEDASRI owner controls independent suppression and provenance keys in Supabase Vault, accessed only through approved database functions, with versioning, rotation, fail-closed behaviour and offline backup (section 4.8) |

---

## 10. Migration sequence, rollback and prerequisites

**Sequence (forward-only; each its own file and its own approval to apply):**
1. **Prerequisite, not SQL (owner action, section 4.8):** the owner generates and stores Vault secrets `prospect_provenance_v1` (needed by Migration A) and `prospect_suppression_v1` (needed by Migration B), 32+ random characters each, and confirms `pgcrypto` is available in `extensions`. Verified on staging first. **Each migration now begins with a pre-flight block** that raises and changes nothing unless its prerequisites exist: A checks `organizations.is_demo`, Vault, `extensions.hmac` and the provenance key; B checks that A is applied and the suppression key exists; X checks that B is applied. Only a secret's name is read, never its value.
2. Migration A (section 15). Everything ships inert: caps zero, no settings row, `GOOGLE_PLACES_ENABLED` false.
3. Optional seed migration: the eight categories and the Madhya Pradesh cities as data.
4. Purge schedule: two `pg_cron` jobs (after R2 and staging).
5. Migration B (section 16): after counsel sign-off on L4, L8, L12, immediately before Phase 7.
6. Migration X (section 17): **only on a separate explicit go-ahead** (it adds the one trigger on `approvals`).

**Rollback (section 18, tested).** Drop in reverse dependency order: X, then B, then A. Every object is new except the single `approvals` trigger, and dropping it restores that table exactly. The repository convention is forward-only; this is an operator runbook for a not-yet-used environment. **Once data exists, do not drop**: stop the runner (`set_prospect_stop`) and fix forward; a drop of tables holding real data is a deliberate, owner-approved act after an export.

**Partial application and rollback (tested, 17 checks):** B without A is refused; X without B is refused; A without Vault or without its key is refused and creates nothing; A alone, A and B, and A, B and X can each be rolled back with the same runbook to a state with no new table, function or trigger. The rollback never touches the Vault secrets (they are owner-held and must not be deleted by a migration); retire a key only by the rule in section 4.8.

**Order in practice:** staging first (blocked on M1), run the hosted role-matrix and concurrency tests, only then production, with the application feature flag still off.

---

## 11. Local test strategy and what has been run

The scratch harness reuses the M5 PGlite pattern (stub roles and `auth`) with two additions: `pgcrypto` installed into an `extensions` schema, and a plain `vault.decrypted_secrets` table standing in for Vault. When implementation is approved this becomes `tests/prospect-schema.test.ts`, plus the drift test (each migration file equals its block in this document).

**Covered by the 273 passing checks (256 main run, 17 dependency and partial-rollback):** thirteen tables, RLS everywhere, anon denied; the existing tables' columns, policies and triggers unchanged (only the approvals trigger added); cross-organisation sweeps (zero rows for another organisation on every table, "not found" with the same message from every function); the full role matrix (viewer, staff, approver, admin, owner); the demonstration organisation refused on every write path and function; owner-only settings and prices; the stop switch (admin stops, owner resumes); missing settings and missing keys failing closed; campaign and monthly request and cost caps with database-computed cost, unit-to-campaign check, append-only ledger and no direct ledger insert; candidate checks, state machine, no delete, no direct decision writes; the cache (30-day ceiling, size limit, fresh-only approver read, expired-but-unpurged row invisible); purge success, step-1 failure logged with SQLSTATE only and the row still hidden, step-2 failure independent, purge status `overdue`; normalisation and keyed hashing (stable across formatting, purpose- and domain-separated, key rotation, missing and short keys); acceptance (atomic, creates nothing on failure, duplicate-retailer check, Google data deleted, id-only activity) and the taint test (a sentinel Google string is nowhere after acceptance); provenance (no direct insert, immutable values, keyed fingerprints with key versions, status after edits and after rotation, existing-CRM attestation); suppression by email, phone, website host and Instagram across formatting variants and key versions; the outreach lifecycle (transition table, single-use approval, draft-hash binding, approval swap refused, attempt numbering, one open attempt, opt-out final, contacted needs provenance); opt-out and erasure (suppression first, approvals redacted, nothing about the retailer remains in any table); the Migration X trigger (refuses a suppressed prospect approval at creation and at approval, always allows rejection, does **not** cover an approval without the marker); rollback.

**Added for the decision closure (O26, O27):** exactly one function in the new SQL deletes from `retailers` (`erase_prospect_retailer`); no trigger on `retailers`; the policy set and the privilege grants on `retailers`, `leads`, `approvals`, `agent_activity` and `audit_log` are identical before and after; an approver or staff user cannot delete a retailer through the prospecting functions; and the pre-flight checks and partial-apply scenarios listed in section 10.

**Still to do at implementation:** an application source-guard test that fails if any code under `src/lib/prospecting` or the prospecting routes issues a direct delete on `retailers` (O26); a check that no key value, and no variable that could hold one, appears in `.env.example`, source or Git history (O27); a concurrency test over real multiple connections on staging (T-B3); `pg_cron` job and history (T-E9); Realtime exclusion (T-E10); backup retention note (T-E11); Hindi and Hinglish scoring tests and the application-side tests from the security review (T-D1 to T-D5, T-K1 to T-K7, T-F1 to T-F5, T-H1 to T-H10), which belong to the code remediation task.

---

## 12. Security review checklist (updated)

- [ ] RLS on every new table, explicit grants, `anon` none (tested).
- [ ] Every definer function: empty `search_path`, schema-qualified, role check, demonstration refusal, same message for missing and other-organisation rows, execute to `authenticated` only (private functions: none).
- [ ] Key functions unreachable by API roles (tested); a missing or short key fails closed (tested, mutation-checked).
- [ ] No column can hold Google text outside `prospect_place_cache`; code arrays check-constrained.
- [ ] Cost cannot be supplied by a caller; counters and decisions unreachable by direct writes; no delete on candidates or the ledger.
- [ ] Demonstration organisations cannot write or spend anywhere (tested).
- [ ] Cache readable by approver and above only, fresh only (tested, mutation-checked).
- [ ] Provenance writable only through the two functions; `google_places` and `trade_directory_permitted` refused.
- [ ] Suppression enforced in the outreach guard and (X) on prospect approvals; limits stated.
- [ ] Erasure suppresses first, redacts, then deletes, and refuses when the key is missing (tested).
- [ ] Existing tables, columns, policies unchanged (tested); the only trigger added is in X.
- [ ] A reviewer has read every `security definer` body, particularly `accept_prospect_candidate`, `erase_prospect_retailer` and `record_prospect_opt_out` (they write to `retailers`, `leads`, `approvals`, `agent_activity`).
- [ ] Hosted staging role-matrix, Vault, `pgcrypto`, `pg_cron`, Realtime and concurrency runs before production.
- [ ] No trigger, policy or grant added on `retailers`; only `erase_prospect_retailer()` deletes retailers from prospecting; direct admin deletion documented as residual risk (O26, tested).
- [ ] Keys: owner-generated, independent, in Vault, versioned, offline backup held, rotation and compromise procedure agreed, no key value in source, Git, prompts or environment files (O27).
- [ ] Pre-flight checks present at the top of A, B and X and tested.
- [ ] Counsel has answered L1 to L5 and L11, L12 before anything is applied.

---

## 13. Application and code work this schema depends on (not part of this proposal)

The Priority 2 code findings, now a separate authorised task to be done **before Phase 4** and not implemented here: P2-1 the duplicate self-match (explicit own-id, a distinct `already_known` result); P2-2 mandatory demo, stop and kill-switch controls through one required reader that fails closed on any error or absence; P2-3 organisation, campaign, unit and tier on reservations and usage events, with the client calling `reserve_prospect_request` and never computing a cost; P2-4 deep-freezing the scoring configuration with a pinned hash; P2-5 the Devanagari normaliser (keep combining marks, strip joiners, whole-token matching), plus the native-speaker review of the Hindi and Hinglish lists (O14); O11, changing existing retailer logging to ids resolved at read time; and a UI rule that prospect approvals collect no free-text note (O12).

---

## 14. Phase 4 dependencies

1. R1 cleared; this schema approved, written as migrations, applied to staging, and the hosted tests passed.
2. The code remediation set (section 13) built and tested.
3. A `prospect:run` permission added to the role matrix (owner, admin), and a server-only repository module (no service role).
4. A database-backed budget gate calling `reserve_prospect_request`, a usage sink, and a cache and candidate repository behind the existing interfaces.
5. The purge scheduled (R2, O24), or at minimum the lazy purge built and tested.
6. `GOOGLE_PLACES_ENABLED` false everywhere until Phase 8; Google Cloud ownership and billing approval are independent and unchanged.

---

## 15. Proposed SQL: Migration A

```sql
-- PROPOSED Migration A, version 2 (NOT a migration file, NOT applied): Google Maps B2B prospecting. Discovery, review, provenance, spend control, purge log. Ten new tables.
-- Requires the foundation migration (organizations incl. is_demo, retailers, leads, agent_activity, private.role_in / is_member / can_write / can_decide / is_admin / append_only),
-- the pgcrypto extension (Supabase installs it in the "extensions" schema) and Supabase Vault (view vault.decrypted_secrets). Both are UNVERIFIED on the hosted project until staging.
-- Adds only new objects. No existing table, column, constraint, policy, grant, function or trigger is changed.
-- Class G (Google-sourced, transient) data lives ONLY in public.prospect_place_cache and in prospect_search_units.page_token.
-- Version 2 applies the approved security review (docs/GOOGLE_MAPS_B2B_SECURITY_REVIEW.md, decisions O4 to O9, O18 to O22).

-- ---------------------------------------------------------------------------
-- Pre-flight checks (decision O27): refuse to run unless the platform pieces and the owner-created key exist. Only the NAME of a secret is read, never its value.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'is_demo') then
    raise exception 'the foundation migration is missing (organizations.is_demo)';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then raise exception 'Supabase Vault is not available'; end if;
  if to_regprocedure('extensions.hmac(bytea, bytea, text)') is null then raise exception 'pgcrypto is not installed in the extensions schema'; end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'prospect_provenance_v1') then
    raise exception 'the owner must create the Vault secret prospect_provenance_v1 first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- A named set of columns may not change after insert. Arguments are the column names.
create or replace function private.prospect_immutable() returns trigger
language plpgsql set search_path = ''
as $$
declare c text;
begin
  foreach c in array tg_argv loop
    if (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c) then
      raise exception '% cannot be changed', c using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- Owner only (caps, prices, resuming after an emergency stop). The foundation has no such helper; role_in() is its role lookup.
create or replace function private.is_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.role_in(p_org) = 'owner', false) $$;
grant execute on function private.is_owner(uuid) to authenticated;

-- A demonstration organisation (organizations.is_demo) can never hold prospecting data or spend. Used in every write policy and every function.
create or replace function private.prospect_org_live(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.organizations o where o.id = p_org and not o.is_demo) $$;
grant execute on function private.prospect_org_live(uuid) to authenticated;

-- ---- Keyed hashing (decisions O5, O6). The ONLY code that touches the secret store is prospect_key_versions() and prospect_key().
-- Secrets are named prospect_<purpose>_v<version> in Vault ('suppression' and 'provenance' are separate keys). A missing or short key RAISES: callers fail closed.
create or replace function private.prospect_key_versions(p_purpose text) returns smallint[]
language plpgsql stable security definer set search_path = ''
as $$
declare v smallint[];
begin
  if p_purpose not in ('suppression', 'provenance') then raise exception 'invalid key purpose' using errcode = '22023'; end if;
  select array_agg((substring(name from '_v([0-9]+)$'))::smallint order by (substring(name from '_v([0-9]+)$'))::smallint)
    into v from vault.decrypted_secrets where name ~ ('^prospect_' || p_purpose || '_v[0-9]+$');
  if v is null then raise exception 'key unavailable' using errcode = '55000'; end if;
  return v;
end $$;

create or replace function private.prospect_key_latest(p_purpose text) returns smallint
language plpgsql stable security definer set search_path = ''
as $$
declare v smallint[] := private.prospect_key_versions(p_purpose);
begin return v[cardinality(v)]; end $$;

create or replace function private.prospect_key(p_purpose text, p_version smallint) returns bytea
language plpgsql stable security definer set search_path = ''
as $$
declare s text;
begin
  if p_purpose not in ('suppression', 'provenance') then raise exception 'invalid key purpose' using errcode = '22023'; end if;
  select decrypted_secret into s from vault.decrypted_secrets where name = 'prospect_' || p_purpose || '_v' || p_version::text;
  if s is null or length(s) < 32 then raise exception 'key unavailable' using errcode = '55000'; end if;
  return convert_to(s, 'UTF8');
end $$;

-- Normalisation is implemented once, here, so the application and the database can never disagree.
create or replace function private.prospect_normalise(p_kind text, p_value text) returns text
language sql immutable set search_path = ''
as $$
  select case p_kind
    when 'phone'     then right(regexp_replace(coalesce(p_value, ''), '\D', '', 'g'), 10)
    when 'email'     then lower(btrim(coalesce(p_value, '')))
    when 'domain'    then regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(p_value, ''))), '^[a-z][a-z0-9+.-]*://', ''), '[/?#].*$', ''), '^www\.', '')
    when 'url'       then regexp_replace(regexp_replace(lower(btrim(coalesce(p_value, ''))), '^[a-z][a-z0-9+.-]*://', ''), '^www\.|/+$', '', 'g')
    when 'instagram' then regexp_replace(regexp_replace(lower(btrim(coalesce(p_value, ''))), '^(https?://)?(www\.)?instagram\.com/', ''), '^@|/+$', '', 'g')
    else regexp_replace(lower(btrim(coalesce(p_value, ''))), '\s+', ' ', 'g')
  end
$$;

-- HMAC-SHA256 over "<kind>:<normalised value>" (the kind separates the domains), hex encoded.
create or replace function private.prospect_hmac(p_purpose text, p_version smallint, p_kind text, p_value text) returns text
language sql stable security definer set search_path = ''
as $$
  select encode(extensions.hmac(convert_to(p_kind || ':' || private.prospect_normalise(p_kind, p_value), 'UTF8'), private.prospect_key(p_purpose, p_version), 'sha256'), 'hex')
$$;

-- Provenance fingerprint: a keyed change-detector for a retailer value as it was when sourced.
create or replace function private.prospect_fingerprint(p_field text, p_value text, p_version smallint) returns text
language sql stable security definer set search_path = ''
as $$
  select private.prospect_hmac('provenance', p_version,
    case p_field when 'email' then 'email' when 'phone' then 'phone' when 'website' then 'url' when 'instagram' then 'instagram' else 'text' end, p_value)
$$;

revoke all on function private.prospect_key_versions(text), private.prospect_key_latest(text), private.prospect_key(text, smallint), private.prospect_hmac(text, smallint, text, text),
  private.prospect_fingerprint(text, text, smallint), private.prospect_normalise(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. prospect_settings: one row per organisation, created by the OWNER. Caps ship at ZERO, so nothing runs until a person sets them (R3).
--    Prices are the ASSUMED top-tier list prices (so estimates err high) until verified in Phase 8; the database computes every cost from them.
-- ---------------------------------------------------------------------------
create table public.prospect_settings (
  org_id                   uuid primary key references public.organizations (id) on delete cascade,
  cache_days               smallint not null default 7 check (cache_days between 1 and 30),
  stop_all                 boolean not null default false,
  stopped_at               timestamptz,
  stopped_by               uuid references auth.users (id) on delete set null,
  monthly_request_cap      integer not null default 0 check (monthly_request_cap >= 0),
  monthly_cost_cap_usd     numeric(10, 2) not null default 0 check (monthly_cost_cap_usd >= 0),
  price_search_usd         numeric(8, 5) not null default 0.035 check (price_search_usd > 0),
  price_details_usd        numeric(8, 5) not null default 0.020 check (price_details_usd > 0),
  price_basis              text not null default 'assumed-top-tier-2026-11' check (char_length(price_basis) between 1 and 40),
  price_verified_at        timestamptz,
  candidate_expiry_days    smallint not null default 90 check (candidate_expiry_days between 7 and 365),
  provenance_review_months smallint not null default 12 check (provenance_review_months between 1 and 60),
  -- Signal-word lists live in CODE (versioned there). This records which code version scores new candidates.
  scoring_version          text not null default 'rubric-2026-11-a' check (char_length(scoring_version) between 1 and 60),
  updated_at               timestamptz not null default now(),
  updated_by               uuid default auth.uid() references auth.users (id) on delete set null
);

-- ---------------------------------------------------------------------------
-- 2. prospect_categories: our own search terms (class P). No signal words here.
-- ---------------------------------------------------------------------------
create table public.prospect_categories (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  label        text not null check (char_length(label) between 1 and 100),
  search_terms text[] not null check (cardinality(search_terms) between 1 and 10 and char_length(array_to_string(search_terms, '|')) <= 600),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (org_id, id)
);
create unique index prospect_categories_label on public.prospect_categories (org_id, lower(label));

-- ---------------------------------------------------------------------------
-- 3. prospect_locations: cities, with expansion support (class P).
-- ---------------------------------------------------------------------------
create table public.prospect_locations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  city         text not null check (char_length(city) between 1 and 100),
  state        text not null check (char_length(state) between 1 and 100),
  tier         smallint check (tier in (1, 2, 3)),
  is_expansion boolean not null default false,
  centre_lat   numeric(8, 5) check (centre_lat between -90 and 90),
  centre_lng   numeric(8, 5) check (centre_lng between -180 and 180),
  radius_km    smallint check (radius_km between 1 and 100),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  check ((centre_lat is null) = (centre_lng is null) and (centre_lat is null) = (radius_km is null))
);
create unique index prospect_locations_city on public.prospect_locations (org_id, lower(city), lower(state));

-- ---------------------------------------------------------------------------
-- 4. prospect_campaigns: definition, hard caps and the atomic spend counters.
--    The counters can be changed ONLY by public.reserve_prospect_request (column privileges below); the checks make overshoot impossible.
-- ---------------------------------------------------------------------------
create table public.prospect_campaigns (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 120),
  status             text not null default 'draft' check (status in ('draft', 'running', 'paused', 'completed', 'stopped')),
  request_cap        integer not null default 0 check (request_cap >= 0),
  cost_cap_usd       numeric(10, 2) not null default 0 check (cost_cap_usd >= 0),
  max_pages_per_unit smallint not null default 3 check (max_pages_per_unit between 1 and 3),
  requests_used      integer not null default 0 check (requests_used >= 0),
  cost_used_usd      numeric(12, 4) not null default 0 check (cost_used_usd >= 0),
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  unique (org_id, id),
  check (requests_used <= request_cap),
  check (cost_used_usd <= cost_cap_usd)
);
create unique index prospect_campaigns_name on public.prospect_campaigns (org_id, lower(name));

-- ---------------------------------------------------------------------------
-- 5. prospect_search_units: term x city. The rows ARE the campaign's selection (created, queued, when the campaign is created; nothing is called).
--    page_token is Google-issued and transient: it must be null once a unit is finished, and the purge clears stale ones.
-- ---------------------------------------------------------------------------
create table public.prospect_search_units (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  campaign_id   uuid not null,
  category_id   uuid not null,
  location_id   uuid not null,
  search_term   text not null check (char_length(search_term) between 1 and 100),
  status        text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'skipped')),
  pages_fetched smallint not null default 0 check (pages_fetched between 0 and 3),
  results_seen  integer not null default 0 check (results_seen >= 0),
  page_token    text check (char_length(page_token) <= 4096),
  page_token_at timestamptz,
  error_code    text check (error_code ~ '^[A-Z][A-Z_]{2,39}$'),
  started_at    timestamptz,
  finished_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, campaign_id, location_id, search_term),
  foreign key (org_id, campaign_id) references public.prospect_campaigns (org_id, id) on delete cascade,
  foreign key (org_id, category_id) references public.prospect_categories (org_id, id) on delete restrict,
  foreign key (org_id, location_id) references public.prospect_locations (org_id, id) on delete restrict,
  check (page_token is null or (status in ('queued', 'running', 'waiting') and page_token_at is not null))
);
create unique index prospect_units_one_running on public.prospect_search_units (org_id, campaign_id) where status = 'running';
create index prospect_units_campaign on public.prospect_search_units (org_id, campaign_id, status);

-- ---------------------------------------------------------------------------
-- 6. prospect_candidates: one row per Google Place ID per organisation (class P). NO Google text columns.
--    Automatic outcomes (auto_*) and human decisions (review_*) are separate columns that different code paths write.
--    score_codes and review_flags may contain only upper-case rule codes: a CHECK refuses any other text, so business names cannot leak in.
--    There is NO delete grant: a rejected Place ID must stay known. Rows leave only through the purge or erase functions.
-- ---------------------------------------------------------------------------
create table public.prospect_candidates (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.organizations (id) on delete cascade,
  campaign_id               uuid not null,
  place_id                  text not null check (place_id ~ '^[A-Za-z0-9_-]{5,255}$'),
  place_id_checked_at       timestamptz not null default now(),
  first_seen_at             timestamptz not null default now(),
  -- automatic (written by the runner, an owner/admin)
  auto_outcome              text not null default 'pending' check (auto_outcome in ('pending', 'duplicate', 'rejected_hard_fact', 'insufficient_information', 'needs_review')),
  auto_rule_code            text check (auto_rule_code ~ '^[A-Z][A-Z_]{2,39}$'),
  scoring_version           text check (char_length(scoring_version) between 1 and 60),
  score_total               smallint check (score_total between 0 and 100),
  score_band                text check (score_band in ('high', 'medium', 'low')),
  pts_category              smallint check (pts_category between 0 and 30),
  pts_assortment            smallint check (pts_assortment between 0 and 25),
  pts_business_model        smallint check (pts_business_model between 0 and 15),
  pts_geography             smallint check (pts_geography between 0 and 10),
  pts_activity              smallint check (pts_activity between 0 and 10),
  pts_contactability        smallint check (pts_contactability between 0 and 10),
  score_codes               text[] check (score_codes is null or (cardinality(score_codes) <= 40 and array_to_string(score_codes, ',') ~ '^[A-Z_,]*$')),
  review_flags              text[] check (review_flags is null or (cardinality(review_flags) <= 20 and array_to_string(review_flags, ',') ~ '^[A-Z_,]*$')),
  scored_at                 timestamptz,
  duplicate_of_candidate_id uuid,
  duplicate_of_retailer_id  uuid,
  -- human (written only by the decide/accept functions)
  review_decision           text check (review_decision in ('accepted', 'rejected', 'needs_more_info', 'not_duplicate')),
  review_reason             text check (review_reason in ('NOT_A_FIT', 'OUT_OF_AREA', 'NO_INDEPENDENT_SOURCE', 'WHOLESALER_OR_MANUFACTURER', 'PRECIOUS_METAL_ONLY', 'PERMANENTLY_CLOSED', 'ALREADY_IN_CRM', 'OTHER')),
  reviewed_by               uuid references auth.users (id) on delete set null,
  reviewed_at               timestamptz,
  retailer_id               uuid,
  expired_at                timestamptz,
  created_at                timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, place_id),
  foreign key (org_id, campaign_id) references public.prospect_campaigns (org_id, id) on delete restrict,
  foreign key (org_id, duplicate_of_candidate_id) references public.prospect_candidates (org_id, id) on delete set null (duplicate_of_candidate_id),
  foreign key (org_id, duplicate_of_retailer_id) references public.retailers (org_id, id) on delete set null (duplicate_of_retailer_id),
  foreign key (org_id, retailer_id) references public.retailers (org_id, id) on delete set null (retailer_id),
  check ((score_total is null) = (score_band is null)),
  check (num_nonnulls(pts_category, pts_assortment, pts_business_model, pts_geography, pts_activity, pts_contactability) in (0, 6)),
  check (duplicate_of_candidate_id is null or duplicate_of_retailer_id is null),
  check (duplicate_of_candidate_id is distinct from id),
  check ((duplicate_of_candidate_id is null and duplicate_of_retailer_id is null) or auto_outcome = 'duplicate'),
  check ((review_decision is null) = (reviewed_at is null)),
  check (review_decision = 'accepted' or retailer_id is null),
  check (review_reason is null or review_decision in ('rejected', 'needs_more_info', 'not_duplicate'))
);
create index prospect_candidates_queue on public.prospect_candidates (org_id, campaign_id, score_band, score_total desc)
  where review_decision is null and expired_at is null and auto_outcome = 'needs_review';
create index prospect_candidates_decided on public.prospect_candidates (org_id, review_decision);
create index prospect_candidates_expiry on public.prospect_candidates (first_seen_at) where review_decision is null and expired_at is null;
create index prospect_candidates_retailer on public.prospect_candidates (org_id, retailer_id) where retailer_id is not null;

-- ---------------------------------------------------------------------------
-- 7. prospect_place_cache: THE ONLY place Google content is stored (class G). Hard 30-day ceiling in the database.
--    Readable only by approvers and above, and only while fresh (policy below), so a failed purge cannot extend access.
-- ---------------------------------------------------------------------------
create table public.prospect_place_cache (
  org_id             uuid not null,
  candidate_id       uuid not null,
  display_name       text check (char_length(display_name) <= 500),
  formatted_address  text check (char_length(formatted_address) <= 1000),
  address_components jsonb check (jsonb_typeof(address_components) = 'array' and pg_column_size(address_components) <= 20000),
  latitude           numeric(8, 5) check (latitude between -90 and 90),
  longitude          numeric(8, 5) check (longitude between -180 and 180),
  types              text[] not null default '{}' check (cardinality(types) <= 50),
  primary_type       text check (char_length(primary_type) <= 80),
  business_status    text check (business_status in ('OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY')),
  national_phone     text check (char_length(national_phone) <= 60),
  website_uri        text check (char_length(website_uri) <= 500),
  rating             numeric(2, 1) check (rating between 0 and 5),
  user_rating_count  integer check (user_rating_count >= 0),
  fetched_at         timestamptz not null default now(),
  details_fetched_at timestamptz,
  expires_at         timestamptz not null,
  primary key (org_id, candidate_id),
  foreign key (org_id, candidate_id) references public.prospect_candidates (org_id, id) on delete cascade,
  check (expires_at > fetched_at and expires_at <= fetched_at + interval '30 days')
);
create index prospect_place_cache_expiry on public.prospect_place_cache (expires_at);

-- ---------------------------------------------------------------------------
-- 8. retailer_contact_sources: FIELD-LEVEL provenance for an independently sourced retailer value (class P).
--    The value itself stays in public.retailers. This row says where it came from, who attested it, and a KEYED fingerprint of the value at that time.
--    'google_places' is not a source type. 'trade_directory_permitted' is not in the list until decision R7 enables it (a later migration adds it).
--    Rows are written ONLY by accept_prospect_candidate() and attest_existing_retailer(): there is no direct insert grant.
-- ---------------------------------------------------------------------------
create table public.retailer_contact_sources (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null,
  retailer_id             uuid not null,
  candidate_id            uuid,
  field                   text not null check (field in ('business', 'location', 'contact', 'email', 'phone', 'instagram', 'website')),
  source_type             text not null check (source_type in ('owner_submitted', 'own_website', 'own_social_page', 'direct_enquiry', 'referral', 'trade_show_or_card', 'existing_crm')),
  source_reference        text not null check (char_length(btrim(source_reference)) between 8 and 300),
  value_fingerprint       text not null check (value_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_key_version smallint not null check (fingerprint_key_version >= 1),
  purpose                 text not null default 'b2b_outreach' check (purpose in ('b2b_outreach')),
  attested                boolean not null check (attested),
  attested_by             uuid references auth.users (id) on delete set null,
  attested_at             timestamptz not null default now(),
  review_after            date not null,
  created_at              timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, retailer_id, field, source_type, value_fingerprint),
  foreign key (org_id, retailer_id) references public.retailers (org_id, id) on delete cascade,
  foreign key (org_id, candidate_id) references public.prospect_candidates (org_id, id) on delete set null (candidate_id)
);
create index retailer_contact_sources_retailer on public.retailer_contact_sources (org_id, retailer_id);
create index retailer_contact_sources_review on public.retailer_contact_sources (org_id, review_after);

-- ---------------------------------------------------------------------------
-- 9. prospect_usage: append-only spend ledger. One row per reserved request (reserved BEFORE the call; a failed call still counts).
--    The cost is computed by the database from prospect_settings prices, never accepted from the caller. It is a ceiling on what we asked Google to do,
--    not Google's invoice. No Google content. actor_id has no foreign key so a user deletion cannot attempt to rewrite an append-only row.
-- ---------------------------------------------------------------------------
create table public.prospect_usage (
  id                 bigint generated always as identity primary key,
  org_id             uuid not null references public.organizations (id) on delete cascade,
  campaign_id        uuid not null,
  unit_id            uuid,
  operation          text not null check (operation in ('searchText', 'placeDetails')),
  tier               text not null check (tier in ('ids_only', 'pro', 'enterprise')),
  estimated_cost_usd numeric(10, 4) not null check (estimated_cost_usd > 0),
  price_basis        text not null check (char_length(price_basis) between 1 and 40),
  at                 timestamptz not null default now(),
  actor_id           uuid,
  foreign key (org_id, campaign_id) references public.prospect_campaigns (org_id, id) on delete restrict,
  foreign key (org_id, unit_id) references public.prospect_search_units (org_id, id) on delete restrict
);
create index prospect_usage_campaign on public.prospect_usage (org_id, campaign_id, at);
create index prospect_usage_month on public.prospect_usage (org_id, at);
create trigger prospect_usage_append_only before update or delete on public.prospect_usage
  for each row execute function private.append_only();

-- ---------------------------------------------------------------------------
-- 10. prospect_purge_runs: append-only, content-free record of each purge step (decision O18). A failure is recorded as a five-character SQLSTATE only.
--     Not readable through the API; the application reads prospect_purge_status().
-- ---------------------------------------------------------------------------
create table public.prospect_purge_runs (
  id            bigint generated always as identity primary key,
  step          text not null check (step in ('cache', 'housekeeping')),
  outcome       text not null check (outcome in ('ok', 'error')),
  rows_affected integer check (rows_affected >= 0),
  error_state   text check (error_state ~ '^[0-9A-Z]{5}$'),
  started_at    timestamptz not null,
  finished_at   timestamptz not null default now(),
  check ((outcome = 'ok') = (error_state is null))
);
create index prospect_purge_runs_step on public.prospect_purge_runs (step, finished_at desc);
create trigger prospect_purge_runs_append_only before update or delete on public.prospect_purge_runs
  for each row execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Row Level Security: default deny, then exactly these grants and policies
-- ---------------------------------------------------------------------------
alter table public.prospect_settings        enable row level security;
alter table public.prospect_categories      enable row level security;
alter table public.prospect_locations       enable row level security;
alter table public.prospect_campaigns       enable row level security;
alter table public.prospect_search_units    enable row level security;
alter table public.prospect_candidates      enable row level security;
alter table public.prospect_place_cache     enable row level security;
alter table public.retailer_contact_sources enable row level security;
alter table public.prospect_usage           enable row level security;
alter table public.prospect_purge_runs      enable row level security;

revoke all on public.prospect_settings, public.prospect_categories, public.prospect_locations, public.prospect_campaigns, public.prospect_search_units,
  public.prospect_candidates, public.prospect_place_cache, public.retailer_contact_sources, public.prospect_usage, public.prospect_purge_runs from anon, authenticated;

grant select on public.prospect_settings, public.prospect_categories, public.prospect_locations, public.prospect_campaigns, public.prospect_search_units,
  public.prospect_candidates, public.prospect_place_cache, public.retailer_contact_sources, public.prospect_usage to authenticated;
grant insert, update, delete on public.prospect_categories, public.prospect_locations to authenticated;
grant delete on public.prospect_campaigns, public.prospect_search_units, public.prospect_place_cache, public.retailer_contact_sources to authenticated;
-- No delete on prospect_candidates, prospect_usage, prospect_settings. No insert or update on prospect_purge_runs. No insert on retailer_contact_sources.

-- Column privileges. Settings: the stop switch is not directly writable (set_prospect_stop). Campaigns: counters are not writable. Candidates: human decisions are not writable.
grant insert (org_id, cache_days, monthly_request_cap, monthly_cost_cap_usd, price_search_usd, price_details_usd, price_basis, price_verified_at,
  candidate_expiry_days, provenance_review_months, scoring_version) on public.prospect_settings to authenticated;
grant update (cache_days, monthly_request_cap, monthly_cost_cap_usd, price_search_usd, price_details_usd, price_basis, price_verified_at,
  candidate_expiry_days, provenance_review_months, scoring_version, updated_at, updated_by) on public.prospect_settings to authenticated;
grant insert (org_id, name, request_cap, cost_cap_usd, max_pages_per_unit) on public.prospect_campaigns to authenticated;
grant update (name, status, request_cap, cost_cap_usd, max_pages_per_unit, updated_at, started_at, finished_at) on public.prospect_campaigns to authenticated;
grant insert (org_id, campaign_id, category_id, location_id, search_term) on public.prospect_search_units to authenticated;
grant update (status, pages_fetched, results_seen, page_token, page_token_at, error_code, started_at, finished_at, updated_at) on public.prospect_search_units to authenticated;
grant insert (org_id, campaign_id, place_id, place_id_checked_at, auto_outcome, auto_rule_code, scoring_version, score_total, score_band, pts_category, pts_assortment,
  pts_business_model, pts_geography, pts_activity, pts_contactability, score_codes, review_flags, scored_at, duplicate_of_candidate_id, duplicate_of_retailer_id)
  on public.prospect_candidates to authenticated;
grant update (place_id_checked_at, auto_outcome, auto_rule_code, scoring_version, score_total, score_band, pts_category, pts_assortment, pts_business_model,
  pts_geography, pts_activity, pts_contactability, score_codes, review_flags, scored_at, duplicate_of_candidate_id, duplicate_of_retailer_id, expired_at)
  on public.prospect_candidates to authenticated;
grant insert (org_id, candidate_id, display_name, formatted_address, address_components, latitude, longitude, types, primary_type, business_status, national_phone,
  website_uri, rating, user_rating_count, fetched_at, details_fetched_at, expires_at) on public.prospect_place_cache to authenticated;
grant update (display_name, formatted_address, address_components, latitude, longitude, types, primary_type, business_status, national_phone, website_uri,
  rating, user_rating_count, fetched_at, details_fetched_at, expires_at) on public.prospect_place_cache to authenticated;
grant update (review_after) on public.retailer_contact_sources to authenticated;

-- Reads: any member (class P). The cache is the exception (below).
do $$
declare t text;
begin
  foreach t in array array['prospect_settings', 'prospect_categories', 'prospect_locations', 'prospect_campaigns', 'prospect_search_units', 'prospect_candidates', 'retailer_contact_sources', 'prospect_usage'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_member(org_id))', t || '_read', t);
  end loop;
  -- Writes: owner/admin, and never for a demonstration organisation.
  foreach t in array array['prospect_categories', 'prospect_locations', 'prospect_campaigns', 'prospect_search_units', 'prospect_candidates', 'prospect_place_cache'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_admin(org_id) and private.prospect_org_live(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_admin(org_id)) with check (private.is_admin(org_id) and private.prospect_org_live(org_id))', t || '_update', t);
  end loop;
  foreach t in array array['prospect_categories', 'prospect_locations', 'prospect_campaigns', 'prospect_search_units', 'prospect_place_cache', 'retailer_contact_sources'] loop
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_admin(org_id))', t || '_delete', t);
  end loop;
end $$;

-- Settings (caps, prices, retention): OWNER only (decision O7).
create policy prospect_settings_insert on public.prospect_settings for insert to authenticated
  with check (private.is_owner(org_id) and private.prospect_org_live(org_id));
create policy prospect_settings_update on public.prospect_settings for update to authenticated
  using (private.is_owner(org_id)) with check (private.is_owner(org_id) and private.prospect_org_live(org_id));

-- Google content: approvers and above only, and only while fresh (decision O8). Expiry is enforced at read time, so a failed purge cannot extend access.
create policy prospect_place_cache_read on public.prospect_place_cache for select to authenticated
  using (private.can_decide(org_id) and expires_at > now() and private.prospect_org_live(org_id));

create policy prospect_usage_no_direct_write on public.prospect_usage for insert to authenticated with check (false);

-- Provenance review dates can be renewed by approvers and above.
create policy retailer_contact_sources_update on public.retailer_contact_sources for update to authenticated
  using (private.can_decide(org_id)) with check (private.can_decide(org_id));

-- ---------------------------------------------------------------------------
-- Guards that RLS alone cannot express
-- ---------------------------------------------------------------------------
create trigger prospect_settings_immutable   before update on public.prospect_settings        for each row execute function private.prospect_immutable('org_id');
create trigger prospect_categories_immutable before update on public.prospect_categories      for each row execute function private.prospect_immutable('id', 'org_id');
create trigger prospect_locations_immutable  before update on public.prospect_locations       for each row execute function private.prospect_immutable('id', 'org_id');
create trigger prospect_campaigns_immutable  before update on public.prospect_campaigns       for each row execute function private.prospect_immutable('id', 'org_id');
create trigger prospect_units_immutable      before update on public.prospect_search_units    for each row execute function private.prospect_immutable('id', 'org_id', 'campaign_id', 'category_id', 'location_id', 'search_term');
create trigger prospect_candidates_immutable before update on public.prospect_candidates     for each row execute function private.prospect_immutable('id', 'org_id', 'campaign_id', 'place_id', 'first_seen_at');
create trigger prospect_cache_immutable      before update on public.prospect_place_cache     for each row execute function private.prospect_immutable('org_id', 'candidate_id');
create trigger retailer_sources_immutable    before update on public.retailer_contact_sources for each row execute function private.prospect_immutable('id', 'org_id', 'retailer_id', 'field', 'source_type', 'source_reference', 'value_fingerprint', 'fingerprint_key_version', 'attested_at');

-- Automatic outcomes follow a small state machine (finding N3). A hard-fact rejection and a duplicate verdict are terminal for the automatic columns; a decided
-- candidate cannot be re-scored. A person's undo of a fuzzy duplicate is recorded in review_decision, not by rewriting auto_outcome.
create or replace function private.prospect_candidate_auto_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.review_decision in ('accepted', 'rejected') then
    raise exception 'a decided candidate cannot be re-scored' using errcode = '23514';
  end if;
  if old.auto_outcome in ('rejected_hard_fact', 'duplicate') then
    raise exception 'a % result is final', old.auto_outcome using errcode = '23514';
  end if;
  return new;
end $$;
create trigger prospect_candidates_auto_guard before update of auto_outcome, auto_rule_code, scoring_version, score_total, score_band, pts_category, pts_assortment,
  pts_business_model, pts_geography, pts_activity, pts_contactability, score_codes, review_flags, scored_at, duplicate_of_candidate_id, duplicate_of_retailer_id
  on public.prospect_candidates for each row execute function private.prospect_candidate_auto_guard();

-- Human decisions follow fixed transitions. Accepted and rejected are final. Acceptance needs a retailer and a recorded source for it.
-- The guard fires only when review_decision is written, so the foreign-key action that clears retailer_id after an erasure is not blocked.
create or replace function private.prospect_candidate_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.review_decision in ('accepted', 'rejected') then
    raise exception 'a % candidate cannot be changed', old.review_decision using errcode = '23514';
  end if;
  if new.review_decision = 'accepted' then
    if new.retailer_id is null or not exists (
      select 1 from public.retailer_contact_sources s
       where s.org_id = new.org_id and s.retailer_id = new.retailer_id and s.field = 'business') then
      raise exception 'acceptance needs a retailer with a recorded source' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.prospect_candidate_guard() from public, anon, authenticated, service_role;
create trigger prospect_candidates_guard before update of review_decision on public.prospect_candidates
  for each row execute function private.prospect_candidate_guard();

-- ---------------------------------------------------------------------------
-- Functions. All SECURITY DEFINER functions: empty search_path, schema-qualified names, an explicit role check, a demonstration-organisation refusal, and the same
-- answer ("not found") for a missing row and another organisation's row, as decide_approval() does. EXECUTE is granted to authenticated only.
-- ---------------------------------------------------------------------------

-- Atomic spend reservation. The runner calls this BEFORE every Google request and makes the request only when status = 'ok'.
-- The cost is computed here from the organisation's stored prices; the caller cannot supply or lower it. Lock order is always settings, then campaign.
create or replace function public.reserve_prospect_request(p_campaign uuid, p_operation text, p_tier text, p_unit uuid default null)
returns table (status text, usage_id bigint, cost_usd numeric)
language plpgsql security definer set search_path = ''
as $$
declare
  org uuid; s public.prospect_settings; c public.prospect_campaigns; cost numeric; new_id bigint;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  m_requests bigint; m_cost numeric;
begin
  if p_operation not in ('searchText', 'placeDetails') or p_tier not in ('ids_only', 'pro', 'enterprise') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select k.org_id into org from public.prospect_campaigns k where k.id = p_campaign;
  if org is null or not private.is_admin(org) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.prospect_org_live(org) then return query select 'demo'::text, null::bigint, null::numeric; return; end if;
  if p_unit is not null and not exists (select 1 from public.prospect_search_units u where u.id = p_unit and u.org_id = org and u.campaign_id = p_campaign) then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into s from public.prospect_settings where org_id = org for update;
  if not found then return query select 'no_settings'::text, null::bigint, null::numeric; return; end if;
  select * into c from public.prospect_campaigns where id = p_campaign and org_id = org for update;
  if s.stop_all then return query select 'stopped'::text, null::bigint, null::numeric; return; end if;
  if c.status <> 'running' then return query select 'campaign_not_running'::text, null::bigint, null::numeric; return; end if;
  cost := case p_operation when 'searchText' then s.price_search_usd else s.price_details_usd end;
  if c.requests_used + 1 > c.request_cap or c.cost_used_usd + cost > c.cost_cap_usd then
    return query select 'cap_reached'::text, null::bigint, null::numeric; return;
  end if;
  select count(*), coalesce(sum(u.estimated_cost_usd), 0) into m_requests, m_cost from public.prospect_usage u where u.org_id = org and u.at >= month_start;
  if m_requests + 1 > s.monthly_request_cap or m_cost + cost > s.monthly_cost_cap_usd then
    return query select 'cap_reached'::text, null::bigint, null::numeric; return;
  end if;
  update public.prospect_campaigns set requests_used = requests_used + 1, cost_used_usd = cost_used_usd + cost, updated_at = now() where id = c.id;
  insert into public.prospect_usage (org_id, campaign_id, unit_id, operation, tier, estimated_cost_usd, price_basis, actor_id)
  values (org, c.id, p_unit, p_operation, p_tier, cost, s.price_basis, (select auth.uid())) returning id into new_id;
  return query select 'ok'::text, new_id, cost;
end $$;

-- Emergency stop. Any owner or admin can stop; only the OWNER can resume. Writes an id-only activity row.
create or replace function public.set_prospect_stop(p_org uuid, p_stop boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := (select auth.uid());
begin
  if not private.is_member(p_org) or not private.is_admin(p_org) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not p_stop and not private.is_owner(p_org) then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.prospect_settings
     set stop_all = p_stop, stopped_at = case when p_stop then now() end, stopped_by = case when p_stop then uid end, updated_at = now(), updated_by = uid
   where org_id = p_org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  insert into public.agent_activity (org_id, agent, action, actor_id)
  values (p_org, 'b2b', case when p_stop then 'Stopped all prospecting' else 'Resumed prospecting' end, uid);
end $$;

-- Acceptance: ONE human act, all or nothing. Creates the retailer and its lead (stage 'new', exactly the rows liveCreateRetailer creates, but atomically),
-- records field-level provenance, marks the candidate accepted, deletes the candidate's Google data, and writes an id-only activity row.
-- p_sources is a JSON array of {field, source_type, source_reference, review_after}; every supplied value needs exactly one entry.
-- An existing retailer with the same phone, email or website host refuses the acceptance unless p_confirm_duplicate is true.
create or replace function public.accept_prospect_candidate(
  p_candidate uuid, p_business text, p_location text, p_category text, p_contact text, p_email text, p_phone text,
  p_instagram text, p_website text, p_sources jsonb, p_attested boolean, p_confirm_duplicate boolean default false
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  cand public.prospect_candidates; rid uuid; uid uuid := (select auth.uid());
  vals jsonb; k text; src jsonb; fpv smallint;
begin
  select * into cand from public.prospect_candidates where id = p_candidate for update;
  if not found or not private.is_member(cand.org_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.can_decide(cand.org_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not private.prospect_org_live(cand.org_id) then raise exception 'not available for a demonstration organisation' using errcode = '42501'; end if;
  if cand.expired_at is not null then raise exception 'candidate has expired' using errcode = '23514'; end if;
  if cand.review_decision is not null and cand.review_decision not in ('needs_more_info', 'not_duplicate') then
    raise exception 'already decided' using errcode = 'P0001';
  end if;
  if not (cand.auto_outcome in ('needs_review', 'insufficient_information') or cand.review_decision = 'not_duplicate') then
    raise exception 'this candidate cannot be accepted' using errcode = '23514';
  end if;
  if p_attested is not true then raise exception 'the attestation is required' using errcode = '23514'; end if;
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' then raise exception 'sources are required' using errcode = '23514'; end if;

  vals := jsonb_build_object('business', nullif(btrim(p_business), ''), 'location', nullif(btrim(p_location), ''), 'contact', nullif(btrim(p_contact), ''),
    'email', nullif(btrim(p_email), ''), 'phone', nullif(btrim(p_phone), ''), 'instagram', nullif(btrim(p_instagram), ''), 'website', nullif(btrim(p_website), ''));
  if vals ->> 'business' is null then raise exception 'a business name is required' using errcode = '23514'; end if;
  if coalesce(vals ->> 'email', vals ->> 'phone', vals ->> 'instagram', vals ->> 'website') is null then
    raise exception 'at least one contact route is required' using errcode = '23514';
  end if;
  for k in select key from jsonb_each(vals) where value <> 'null'::jsonb loop
    if (select count(*) from jsonb_array_elements(p_sources) e where e ->> 'field' = k) <> 1 then
      raise exception 'exactly one source is required for every supplied value' using errcode = '23514';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_sources) e where (vals -> (e ->> 'field')) is null or (vals -> (e ->> 'field')) = 'null'::jsonb) then
    raise exception 'a source was given for a value that was not supplied' using errcode = '23514';
  end if;

  if not coalesce(p_confirm_duplicate, false) and exists (
    select 1 from public.retailers r where r.org_id = cand.org_id and (
      (private.prospect_normalise('phone', vals ->> 'phone') <> '' and private.prospect_normalise('phone', r.phone) = private.prospect_normalise('phone', vals ->> 'phone'))
      or (private.prospect_normalise('email', vals ->> 'email') <> '' and private.prospect_normalise('email', r.email) = private.prospect_normalise('email', vals ->> 'email'))
      or (private.prospect_normalise('domain', vals ->> 'website') <> '' and private.prospect_normalise('domain', r.website) = private.prospect_normalise('domain', vals ->> 'website')))) then
    raise exception 'possible duplicate retailer' using errcode = '23505';
  end if;

  fpv := private.prospect_key_latest('provenance');   -- raises 'key unavailable' when no key exists: fails closed

  insert into public.retailers (org_id, business, location, category, contact, email, phone, instagram, website)
  values (cand.org_id, vals ->> 'business', vals ->> 'location', nullif(btrim(p_category), ''), vals ->> 'contact', vals ->> 'email', vals ->> 'phone', vals ->> 'instagram', vals ->> 'website')
  returning id into rid;
  insert into public.leads (org_id, retailer_id, stage) values (cand.org_id, rid, 'new');

  for src in select * from jsonb_array_elements(p_sources) loop
    insert into public.retailer_contact_sources (org_id, retailer_id, candidate_id, field, source_type, source_reference, value_fingerprint, fingerprint_key_version, attested, attested_by, review_after)
    values (cand.org_id, rid, cand.id, src ->> 'field', src ->> 'source_type', src ->> 'source_reference',
            private.prospect_fingerprint(src ->> 'field', vals ->> (src ->> 'field'), fpv), fpv, true, uid, (src ->> 'review_after')::date);
  end loop;

  update public.prospect_candidates
     set review_decision = 'accepted', review_reason = null, reviewed_by = uid, reviewed_at = now(), retailer_id = rid
   where id = cand.id;
  delete from public.prospect_place_cache where org_id = cand.org_id and candidate_id = cand.id;
  insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id)
  values (cand.org_id, 'b2b', 'Accepted a prospect candidate into the CRM', 'prospect_candidate', cand.id, uid);
  return rid;
end $$;

-- Rejection, "needs more information", and undoing a fuzzy duplicate. Closed reason codes only (the table check refuses anything else).
create or replace function public.decide_prospect_candidate(p_candidate uuid, p_decision text, p_reason text default null)
returns public.prospect_candidates
language plpgsql security definer set search_path = ''
as $$
declare cand public.prospect_candidates; uid uuid := (select auth.uid());
begin
  if p_decision not in ('rejected', 'needs_more_info', 'not_duplicate') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into cand from public.prospect_candidates where id = p_candidate for update;
  if not found or not private.is_member(cand.org_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.can_decide(cand.org_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not private.prospect_org_live(cand.org_id) then raise exception 'not available for a demonstration organisation' using errcode = '42501'; end if;
  if p_decision = 'not_duplicate' and not (cand.auto_outcome = 'duplicate' and cand.auto_rule_code is distinct from 'DUP_PLACE_ID') then
    raise exception 'only a fuzzy duplicate match can be undone' using errcode = '23514';
  end if;
  update public.prospect_candidates
     set review_decision = p_decision, review_reason = p_reason, reviewed_by = uid, reviewed_at = now()
   where id = cand.id returning * into cand;
  insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id)
  values (cand.org_id, 'b2b', case p_decision when 'rejected' then 'Rejected a prospect candidate' when 'needs_more_info' then 'Marked a prospect candidate as needing more information' else 'Undid a duplicate match on a prospect candidate' end,
          'prospect_candidate', cand.id, uid);
  return cand;
end $$;

-- Existing-CRM attestation path: an approver or above attests that an EXISTING retailer's current values are independently sourced, field by field.
-- One retailer per call (there is no bulk form). Writes an id-only activity row when anything is recorded.
create or replace function public.attest_existing_retailer(p_retailer uuid, p_fields text[], p_reference text, p_review_after date, p_attested boolean)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare r public.retailers; f text; v text; n integer := 0; uid uuid := (select auth.uid()); added integer; fpv smallint;
begin
  select * into r from public.retailers where id = p_retailer;
  if not found or not private.is_member(r.org_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.can_decide(r.org_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not private.prospect_org_live(r.org_id) then raise exception 'not available for a demonstration organisation' using errcode = '42501'; end if;
  if p_attested is not true then raise exception 'the attestation is required' using errcode = '23514'; end if;
  fpv := private.prospect_key_latest('provenance');
  foreach f in array p_fields loop
    v := case f when 'business' then r.business when 'location' then r.location when 'contact' then r.contact when 'email' then r.email
                when 'phone' then r.phone when 'instagram' then r.instagram when 'website' then r.website else null end;
    if v is null or btrim(v) = '' then continue; end if;
    insert into public.retailer_contact_sources (org_id, retailer_id, field, source_type, source_reference, value_fingerprint, fingerprint_key_version, attested, attested_by, review_after)
    values (r.org_id, r.id, f, 'existing_crm', p_reference, private.prospect_fingerprint(f, v, fpv), fpv, true, uid, p_review_after)
    on conflict do nothing;
    get diagnostics added = row_count;
    n := n + added;
  end loop;
  if n > 0 then
    insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id)
    values (r.org_id, 'b2b', 'Attested the sources of an existing retailer', 'retailer', r.id, uid);
  end if;
  return n;
end $$;

-- Which of a retailer's values have a source that still matches the current value (not edited since), and which reviews are due.
-- SECURITY DEFINER because it needs the provenance key; it first checks membership of the retailer's own organisation and returns nothing otherwise.
create or replace function public.prospect_contact_status(p_retailer uuid)
returns table (field text, has_value boolean, sourced boolean, review_due boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare r public.retailers;
begin
  select * into r from public.retailers where id = p_retailer;
  if not found or not private.is_member(r.org_id) then return; end if;
  return query
  select f.field,
         (f.val is not null and btrim(f.val) <> ''),
         exists (select 1 from public.retailer_contact_sources s where s.retailer_id = r.id and s.field = f.field
                  and s.value_fingerprint = private.prospect_fingerprint(f.field, f.val, s.fingerprint_key_version)),
         not exists (select 1 from public.retailer_contact_sources s where s.retailer_id = r.id and s.field = f.field
                  and s.value_fingerprint = private.prospect_fingerprint(f.field, f.val, s.fingerprint_key_version) and s.review_after > current_date)
    from unnest(array['business', 'location', 'contact', 'email', 'phone', 'instagram', 'website'],
                array[r.business, r.location, r.contact, r.email, r.phone, r.instagram, r.website]) as f(field, val);
end $$;

-- Purge step 1 (critical, its own transaction): delete expired Google data, in bounded batches. A failure is logged as a SQLSTATE and returns -1, never raising,
-- so the log row survives. Run by the scheduler (a separate, separately approved migration) and callable by nobody else.
create or replace function private.purge_expired_place_cache() returns integer
language plpgsql security definer set search_path = ''
as $$
declare n integer := 0; t0 timestamptz := clock_timestamp();
begin
  begin
    with d as (delete from public.prospect_place_cache where ctid in (select p.ctid from public.prospect_place_cache p where p.expires_at <= now() limit 5000) returning 1)
    select count(*) into n from d;
    insert into public.prospect_purge_runs (step, outcome, rows_affected, started_at) values ('cache', 'ok', n, t0);
  exception when others then
    insert into public.prospect_purge_runs (step, outcome, error_state, started_at) values ('cache', 'error', sqlstate, t0);
    return -1;
  end;
  return n;
end $$;

-- Purge step 2 (housekeeping, independent of step 1): expire stale unreviewed candidates, delete their Google data, clear stale page tokens.
create or replace function private.run_prospect_housekeeping() returns integer
language plpgsql security definer set search_path = ''
as $$
declare n integer := 0; m integer; t0 timestamptz := clock_timestamp();
begin
  begin
    update public.prospect_candidates c set expired_at = now()
      from public.prospect_settings s
     where s.org_id = c.org_id and c.expired_at is null and c.review_decision is null
       and c.first_seen_at < now() - make_interval(days => s.candidate_expiry_days);
    get diagnostics n = row_count;
    delete from public.prospect_place_cache pc using public.prospect_candidates c
     where c.org_id = pc.org_id and c.id = pc.candidate_id and c.expired_at is not null;
    update public.prospect_search_units set page_token = null, page_token_at = null
     where page_token is not null and page_token_at < now() - interval '1 day';
    get diagnostics m = row_count;
    insert into public.prospect_purge_runs (step, outcome, rows_affected, started_at) values ('housekeeping', 'ok', n + m, t0);
  exception when others then
    insert into public.prospect_purge_runs (step, outcome, error_state, started_at) values ('housekeeping', 'error', sqlstate, t0);
    return -1;
  end;
  return n;
end $$;
revoke all on function private.purge_expired_place_cache(), private.run_prospect_housekeeping() from public, anon, authenticated, service_role;

-- "Purge expired now" (lazy purge, called at the start of prospecting requests) and "Purge everything now" (owner/admin). Both content-free.
create or replace function public.purge_prospect_expired(p_org uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare n integer;
begin
  if not private.is_member(p_org) or not private.is_admin(p_org) then raise exception 'not found' using errcode = 'P0002'; end if;
  delete from public.prospect_place_cache where org_id = p_org and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.purge_prospect_cache_now(p_org uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare n integer;
begin
  if not private.is_member(p_org) or not private.is_admin(p_org) then raise exception 'not found' using errcode = 'P0002'; end if;
  delete from public.prospect_place_cache where org_id = p_org;
  get diagnostics n = row_count;
  update public.prospect_search_units set page_token = null, page_token_at = null where org_id = p_org and page_token is not null;
  return n;
end $$;

-- Is the purge keeping up? "overdue" is true when an expired cache row for the organisation is more than two hours past its expiry.
create or replace function public.prospect_purge_status(p_org uuid) returns table (last_cache_purge_ok timestamptz, overdue boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_member(p_org) then return; end if;
  return query select (select max(r.finished_at) from public.prospect_purge_runs r where r.step = 'cache' and r.outcome = 'ok'),
                      exists (select 1 from public.prospect_place_cache c where c.org_id = p_org and c.expires_at < now() - interval '2 hours');
end $$;

revoke all on function public.reserve_prospect_request(uuid, text, text, uuid), public.set_prospect_stop(uuid, boolean),
  public.accept_prospect_candidate(uuid, text, text, text, text, text, text, text, text, jsonb, boolean, boolean), public.decide_prospect_candidate(uuid, text, text),
  public.attest_existing_retailer(uuid, text[], text, date, boolean), public.prospect_contact_status(uuid), public.purge_prospect_expired(uuid),
  public.purge_prospect_cache_now(uuid), public.prospect_purge_status(uuid) from public, anon;
grant execute on function public.reserve_prospect_request(uuid, text, text, uuid), public.set_prospect_stop(uuid, boolean),
  public.accept_prospect_candidate(uuid, text, text, text, text, text, text, text, text, jsonb, boolean, boolean), public.decide_prospect_candidate(uuid, text, text),
  public.attest_existing_retailer(uuid, text[], text, date, boolean), public.prospect_contact_status(uuid), public.purge_prospect_expired(uuid),
  public.purge_prospect_cache_now(uuid), public.prospect_purge_status(uuid) to authenticated;
```

## 16. Proposed SQL: Migration B (later)

```sql
-- PROPOSED Migration B, version 2 (NOT a migration file, NOT applied): outreach tracking, draft storage and suppression. Three new tables.
-- Ships LATER than Migration A, after counsel sign-off (decisions R1, R4, R6, L4, L8). Requires Migration A (key helpers, retailer_contact_sources, prospect_org_live)
-- and the foundation (approvals, retailers). Adds only new objects. Version 2 applies decisions O3, O5, O10, O13, O15, O23.

-- Pre-flight checks: Migration A must be applied, and the owner must have created the suppression key (decision O27). Only the secret's NAME is read.
do $$
begin
  if to_regprocedure('private.prospect_org_live(uuid)') is null or to_regclass('public.retailer_contact_sources') is null then
    raise exception 'Migration A must be applied first';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or not exists (select 1 from vault.decrypted_secrets where name = 'prospect_suppression_v1') then
    raise exception 'the owner must create the Vault secret prospect_suppression_v1 first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 11. prospect_suppressions: keyed-hash opt-out list. The database never holds an address or number, only an HMAC computed INSIDE the database from a Vault key
--     (purpose 'suppression', versioned). Rows are written only by add_prospect_suppression(), record_prospect_opt_out() and erase_prospect_retailer().
--     A hash cannot be re-hashed: a key version stays active for as long as rows under it exist, and a leaked key means every hash under it is exposed.
--     There is no removal path in version 1 (decision O3): a genuine mistake is a manual, owner-run, counsel-approved procedure.
-- ---------------------------------------------------------------------------
create table public.prospect_suppressions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  kind        text not null check (kind in ('email', 'phone', 'domain', 'instagram')),
  key_version smallint not null check (key_version >= 1),
  key_hash    text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  reason      text not null check (reason in ('opted_out', 'bounced', 'complained', 'manual', 'erased')),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, kind, key_version, key_hash)
);
create trigger prospect_suppressions_append_only before update or delete on public.prospect_suppressions
  for each row execute function private.append_only();

-- ---------------------------------------------------------------------------
-- 12. prospect_outreach_drafts: the draft text lives HERE, not in an approval, so it is deleted with the retailer (decision O10). The approval holds a shell title
--     and preview, and meta {kind, ref, draft_id, draft_sha256}; the hash binds the approval to this exact text. A draft is never edited: a new text is a new row.
-- ---------------------------------------------------------------------------
create table public.prospect_outreach_drafts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  retailer_id uuid not null,
  channel     text not null check (channel in ('email', 'whatsapp', 'instagram')),
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, retailer_id) references public.retailers (org_id, id) on delete cascade
);
create index prospect_outreach_drafts_retailer on public.prospect_outreach_drafts (org_id, retailer_id);
-- The hash is always computed here, so it can never disagree with the stored text.
create or replace function private.prospect_draft_hash() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.body_sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
  return new;
end $$;
create trigger prospect_outreach_drafts_hash before insert on public.prospect_outreach_drafts
  for each row execute function private.prospect_draft_hash();

-- ---------------------------------------------------------------------------
-- 13. prospect_outreach: one row per ATTEMPT (retailer and channel), with the eight states of specification FR12 (decisions O15, O23). No message text.
-- ---------------------------------------------------------------------------
create table public.prospect_outreach (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  retailer_id  uuid not null,
  channel      text not null check (channel in ('email', 'whatsapp', 'instagram')),
  attempt      smallint not null default 1 check (attempt >= 1),
  status       text not null default 'drafted' check (status in ('drafted', 'pending_approval', 'approved', 'contacted', 'interested', 'not_interested', 'follow_up_required', 'opted_out')),
  draft_id     uuid,
  approval_id  uuid,
  contacted_at timestamptz,
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, retailer_id, channel, attempt),
  foreign key (org_id, retailer_id) references public.retailers (org_id, id) on delete cascade,
  foreign key (org_id, draft_id) references public.prospect_outreach_drafts (org_id, id) on delete set null (draft_id),
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete set null (approval_id)
);
create index prospect_outreach_retailer on public.prospect_outreach (org_id, retailer_id);
-- An approval authorises exactly one attempt.
create unique index prospect_outreach_one_approval on public.prospect_outreach (org_id, approval_id) where approval_id is not null;
-- At most one open (not yet contacted) attempt per retailer and channel.
create unique index prospect_outreach_one_open on public.prospect_outreach (org_id, retailer_id, channel) where status in ('drafted', 'pending_approval', 'approved');

alter table public.prospect_suppressions    enable row level security;
alter table public.prospect_outreach_drafts enable row level security;
alter table public.prospect_outreach        enable row level security;
revoke all on public.prospect_suppressions, public.prospect_outreach_drafts, public.prospect_outreach from anon, authenticated;
grant select on public.prospect_suppressions to authenticated;
grant select on public.prospect_outreach_drafts to authenticated;
grant insert (org_id, retailer_id, channel, body) on public.prospect_outreach_drafts to authenticated;
grant select on public.prospect_outreach to authenticated;
grant insert (org_id, retailer_id, channel, draft_id, approval_id) on public.prospect_outreach to authenticated;
grant update (status, draft_id, approval_id) on public.prospect_outreach to authenticated;

create policy prospect_suppressions_read on public.prospect_suppressions for select to authenticated using (private.is_member(org_id));
create policy prospect_outreach_drafts_read on public.prospect_outreach_drafts for select to authenticated using (private.is_member(org_id));
create policy prospect_outreach_drafts_insert on public.prospect_outreach_drafts for insert to authenticated
  with check (private.can_write(org_id) and private.prospect_org_live(org_id));
create policy prospect_outreach_read on public.prospect_outreach for select to authenticated using (private.is_member(org_id));
create policy prospect_outreach_insert on public.prospect_outreach for insert to authenticated
  with check (private.can_write(org_id) and private.prospect_org_live(org_id));
create policy prospect_outreach_update on public.prospect_outreach for update to authenticated
  using (private.can_write(org_id)) with check (private.can_write(org_id) and private.prospect_org_live(org_id));

create trigger prospect_outreach_immutable before update on public.prospect_outreach
  for each row execute function private.prospect_immutable('id', 'org_id', 'retailer_id', 'channel', 'attempt');

-- ---------------------------------------------------------------------------
-- Suppression: one implementation of "is this retailer suppressed". It hashes the retailer's CURRENT email, phone, website host and Instagram handle under EVERY
-- active key version. A missing key RAISES (fail closed): the callers below refuse rather than skip the check.
-- ---------------------------------------------------------------------------
create or replace function private.retailer_is_suppressed(p_org uuid, p_retailer uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare r public.retailers; v smallint; he text; hp text; hd text; hi text;
begin
  select * into r from public.retailers where id = p_retailer and org_id = p_org;
  if not found then return false; end if;
  foreach v in array private.prospect_key_versions('suppression') loop
    he := case when private.prospect_normalise('email', r.email) <> '' then private.prospect_hmac('suppression', v, 'email', r.email) end;
    hp := case when private.prospect_normalise('phone', r.phone) <> '' then private.prospect_hmac('suppression', v, 'phone', r.phone) end;
    hd := case when private.prospect_normalise('domain', r.website) <> '' then private.prospect_hmac('suppression', v, 'domain', r.website) end;
    hi := case when private.prospect_normalise('instagram', r.instagram) <> '' then private.prospect_hmac('suppression', v, 'instagram', r.instagram) end;
    if exists (select 1 from public.prospect_suppressions s where s.org_id = p_org and s.key_version = v and
        ((s.kind = 'email' and s.key_hash = he) or (s.kind = 'phone' and s.key_hash = hp) or (s.kind = 'domain' and s.key_hash = hd) or (s.kind = 'instagram' and s.key_hash = hi))) then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- Records a suppression for every identifier a retailer has, under the latest key version. Returns how many were new.
create or replace function private.suppress_retailer(p_retailer public.retailers, p_reason text, p_actor uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare v smallint := private.prospect_key_latest('suppression'); n integer := 0; k integer;
begin
  if private.prospect_normalise('email', p_retailer.email) <> '' then
    insert into public.prospect_suppressions (org_id, kind, key_version, key_hash, reason, created_by)
    values (p_retailer.org_id, 'email', v, private.prospect_hmac('suppression', v, 'email', p_retailer.email), p_reason, p_actor) on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;
  if private.prospect_normalise('phone', p_retailer.phone) <> '' then
    insert into public.prospect_suppressions (org_id, kind, key_version, key_hash, reason, created_by)
    values (p_retailer.org_id, 'phone', v, private.prospect_hmac('suppression', v, 'phone', p_retailer.phone), p_reason, p_actor) on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;
  if private.prospect_normalise('domain', p_retailer.website) <> '' then
    insert into public.prospect_suppressions (org_id, kind, key_version, key_hash, reason, created_by)
    values (p_retailer.org_id, 'domain', v, private.prospect_hmac('suppression', v, 'domain', p_retailer.website), p_reason, p_actor) on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;
  if private.prospect_normalise('instagram', p_retailer.instagram) <> '' then
    insert into public.prospect_suppressions (org_id, kind, key_version, key_hash, reason, created_by)
    values (p_retailer.org_id, 'instagram', v, private.prospect_hmac('suppression', v, 'instagram', p_retailer.instagram), p_reason, p_actor) on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;
  return n;
end $$;

-- The rules RLS cannot express, for prospect_outreach:
--   * a new attempt starts as 'drafted'; the attempt number is assigned here; nothing may be created for a retailer that has opted out;
--   * statuses move only along the allowed transitions; 'opted_out' is reachable from every open state and is final;
--   * entering pending_approval, approved or contacted needs: the retailer NOT suppressed (any key version), an approval for THIS retailer of kind
--     'prospect_outreach' in the right state, and a draft of this retailer and channel whose hash equals the approval's meta.draft_sha256;
--   * contacted also needs a recorded independent source for the retailer and stamps contacted_at;
--   * once set, the approval and the draft cannot be swapped.
create or replace function private.prospect_outreach_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare a public.approvals; d public.prospect_outreach_drafts; allowed boolean;
begin
  if tg_op = 'INSERT' then
    -- Recording an opt-out must always be possible. The API roles have no insert privilege on the status column, so only the definer functions below can insert 'opted_out'.
    if new.status = 'opted_out' then
      new.attempt := coalesce((select max(o.attempt) from public.prospect_outreach o where o.org_id = new.org_id and o.retailer_id = new.retailer_id and o.channel = new.channel), 0) + 1;
      new.updated_at := now();
      return new;
    end if;
    if new.status <> 'drafted' then raise exception 'a new attempt starts as drafted' using errcode = '23514'; end if;
    if exists (select 1 from public.prospect_outreach o where o.org_id = new.org_id and o.retailer_id = new.retailer_id and o.status = 'opted_out') then
      raise exception 'this retailer has opted out' using errcode = '23514';
    end if;
    if private.retailer_is_suppressed(new.org_id, new.retailer_id) then raise exception 'this contact is suppressed' using errcode = '23514'; end if;
    new.attempt := coalesce((select max(o.attempt) from public.prospect_outreach o where o.org_id = new.org_id and o.retailer_id = new.retailer_id and o.channel = new.channel), 0) + 1;
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'opted_out' then raise exception 'an opted-out retailer cannot be changed' using errcode = '23514'; end if;
  if old.approval_id is not null and new.approval_id is distinct from old.approval_id then raise exception 'the approval cannot be changed' using errcode = '23514'; end if;
  if old.draft_id is not null and new.draft_id is distinct from old.draft_id then raise exception 'the draft cannot be changed' using errcode = '23514'; end if;

  if new.status is distinct from old.status then
    allowed := (old.status || '>' || new.status) = any (array[
      'drafted>pending_approval', 'pending_approval>approved', 'pending_approval>drafted', 'approved>contacted',
      'contacted>interested', 'contacted>not_interested', 'contacted>follow_up_required',
      'follow_up_required>interested', 'follow_up_required>not_interested', 'interested>not_interested',
      'drafted>opted_out', 'pending_approval>opted_out', 'approved>opted_out', 'contacted>opted_out',
      'interested>opted_out', 'not_interested>opted_out', 'follow_up_required>opted_out']);
    if not allowed then raise exception 'that status change is not allowed' using errcode = '23514'; end if;

    if new.status in ('pending_approval', 'approved', 'contacted') then
      if private.retailer_is_suppressed(new.org_id, new.retailer_id) then raise exception 'this contact is suppressed' using errcode = '23514'; end if;
      select * into a from public.approvals where org_id = new.org_id and id = new.approval_id;
      if not found or a.generated_by <> 'b2b' or a.meta ->> 'kind' is distinct from 'prospect_outreach' or a.meta ->> 'ref' is distinct from new.retailer_id::text then
        raise exception 'an approval for this retailer is required' using errcode = '23514';
      end if;
      if (new.status = 'pending_approval' and a.status <> 'pending') or (new.status <> 'pending_approval' and a.status not in ('approved', 'executed')) then
        raise exception 'the approval is not in the right state' using errcode = '23514';
      end if;
      select * into d from public.prospect_outreach_drafts where org_id = new.org_id and id = new.draft_id;
      if not found or d.retailer_id <> new.retailer_id or d.channel <> new.channel or a.meta ->> 'draft_sha256' is distinct from d.body_sha256 then
        raise exception 'the approval does not match the draft' using errcode = '23514';
      end if;
      if new.status = 'contacted' then
        if not exists (select 1 from public.retailer_contact_sources s where s.org_id = new.org_id and s.retailer_id = new.retailer_id) then
          raise exception 'contact needs a recorded independent source' using errcode = '23514';
        end if;
        new.contacted_at := coalesce(new.contacted_at, now());
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.retailer_is_suppressed(uuid, uuid), private.suppress_retailer(public.retailers, text, uuid), private.prospect_outreach_guard() from public, anon, authenticated, service_role;
create trigger prospect_outreach_guard before insert or update on public.prospect_outreach
  for each row execute function private.prospect_outreach_guard();

-- ---------------------------------------------------------------------------
-- Functions (SECURITY DEFINER, empty search_path, explicit role check, demonstration-organisation refusal, "not found" for missing and other-organisation rows)
-- ---------------------------------------------------------------------------

-- Manual suppression of a contact that is not (yet) a retailer: an approver or above supplies the value; only its keyed hash is stored.
create or replace function public.add_prospect_suppression(p_org uuid, p_kind text, p_value text, p_reason text default 'manual') returns void
language plpgsql security definer set search_path = ''
as $$
declare v smallint; uid uuid := (select auth.uid());
begin
  if not private.is_member(p_org) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.can_decide(p_org) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not private.prospect_org_live(p_org) then raise exception 'not available for a demonstration organisation' using errcode = '42501'; end if;
  if p_kind not in ('email', 'phone', 'domain', 'instagram') or p_reason not in ('opted_out', 'bounced', 'complained', 'manual') then raise exception 'invalid request' using errcode = '22023'; end if;
  if private.prospect_normalise(p_kind, p_value) = '' then raise exception 'a value is required' using errcode = '22023'; end if;
  v := private.prospect_key_latest('suppression');
  insert into public.prospect_suppressions (org_id, kind, key_version, key_hash, reason, created_by)
  values (p_org, p_kind, v, private.prospect_hmac('suppression', v, p_kind, p_value), p_reason, uid) on conflict do nothing;
  insert into public.agent_activity (org_id, agent, action, actor_id) values (p_org, 'b2b', 'Added a contact to the suppression list', uid);
end $$;

-- A retailer opts out (or a bounce or complaint is recorded): suppress EVERY identifier it has, on every channel, and close every open attempt, in one transaction.
create or replace function public.record_prospect_opt_out(p_retailer uuid, p_channel text, p_reason text default 'opted_out') returns integer
language plpgsql security definer set search_path = ''
as $$
declare r public.retailers; n integer; uid uuid := (select auth.uid());
begin
  select * into r from public.retailers where id = p_retailer;
  if not found or not private.is_member(r.org_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.can_write(r.org_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not private.prospect_org_live(r.org_id) then raise exception 'not available for a demonstration organisation' using errcode = '42501'; end if;
  if p_channel not in ('email', 'whatsapp', 'instagram') or p_reason not in ('opted_out', 'bounced', 'complained') then raise exception 'invalid request' using errcode = '22023'; end if;
  n := private.suppress_retailer(r, p_reason, uid);
  update public.prospect_outreach set status = 'opted_out' where org_id = r.org_id and retailer_id = r.id and status <> 'opted_out';
  if not exists (select 1 from public.prospect_outreach o where o.org_id = r.org_id and o.retailer_id = r.id and o.status = 'opted_out') then
    insert into public.prospect_outreach (org_id, retailer_id, channel, status) values (r.org_id, r.id, p_channel, 'opted_out');
  end if;
  insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id) values (r.org_id, 'b2b', 'Recorded an opt-out for a retailer', 'retailer', r.id, uid);
  return n;
end $$;

-- Erasure on request (owner or admin). Suppress first (so the person is not contacted again), redact every approval that points at the retailer, then delete the
-- retailer; its lead, provenance, outreach and drafts cascade, and candidates are unlinked. If the suppression key is missing this RAISES and nothing is deleted.
-- Append-only history (agent_activity, audit_log) is NOT touched: see specification section 6.6.
create or replace function public.erase_prospect_retailer(p_retailer uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare r public.retailers; uid uuid := (select auth.uid());
begin
  select * into r from public.retailers where id = p_retailer;
  if not found or not private.is_member(r.org_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.is_admin(r.org_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if not private.prospect_org_live(r.org_id) then raise exception 'not available for a demonstration organisation' using errcode = '42501'; end if;
  perform private.suppress_retailer(r, 'erased', uid);
  update public.approvals
     set title = '[redacted]', preview = '[redacted]',
         meta = jsonb_build_object('kind', meta ->> 'kind', 'ref', meta ->> 'ref', 'redacted', true)
   where org_id = r.org_id and meta ->> 'ref' = r.id::text;
  delete from public.retailers where id = r.id and org_id = r.org_id;
  insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id) values (r.org_id, 'b2b', 'Erased a retailer on request', 'retailer', r.id, uid);
end $$;

-- UI helper: is this retailer suppressed? (members only; fails closed with an error if the key is missing)
create or replace function public.prospect_retailer_suppressed(p_retailer uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare r public.retailers;
begin
  select * into r from public.retailers where id = p_retailer;
  if not found or not private.is_member(r.org_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  return private.retailer_is_suppressed(r.org_id, r.id);
end $$;

revoke all on function public.add_prospect_suppression(uuid, text, text, text), public.record_prospect_opt_out(uuid, text, text),
  public.erase_prospect_retailer(uuid), public.prospect_retailer_suppressed(uuid) from public, anon;
grant execute on function public.add_prospect_suppression(uuid, text, text, text), public.record_prospect_opt_out(uuid, text, text),
  public.erase_prospect_retailer(uuid), public.prospect_retailer_suppressed(uuid) to authenticated;
```

## 17. Proposed SQL: Migration X (optional, separate go-ahead)

```sql
-- PROPOSED Migration X (NOT a migration file, NOT applied): the ONLY change to an existing table, and only if the owner approves it (decision O1).
-- It adds ONE trigger to public.approvals. No column, policy, grant or existing function is changed (decide_approval() is untouched: it approves by UPDATE,
-- so the trigger fires without altering it). Requires Migration B (private.retailer_is_suppressed).
--
-- Scope and honest limit: it covers approvals that carry meta.kind = 'prospect_outreach'. An approval created WITHOUT that marker is not covered (changing the
-- approvals insert policy to force the marker was decision O2: not taken). It cannot stop anyone messaging a person outside the system.

-- Pre-flight check: Migration B must be applied first (the trigger calls private.retailer_is_suppressed).
do $$
begin
  if to_regprocedure('private.retailer_is_suppressed(uuid, uuid)') is null then raise exception 'Migration B must be applied first'; end if;
end $$;
create or replace function private.prospect_approval_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare ref uuid;
begin
  if new.generated_by = 'b2b' and new.meta ->> 'kind' = 'prospect_outreach' and new.status <> 'rejected' then
    if new.meta ->> 'ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'a prospect approval must reference a retailer' using errcode = '23514';
    end if;
    ref := (new.meta ->> 'ref')::uuid;
    if private.retailer_is_suppressed(new.org_id, ref) then
      raise exception 'this contact is suppressed' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.prospect_approval_guard() from public, anon, authenticated, service_role;
-- Fires on creation and on every status change (so decide_approval() is covered), never on a metadata-only redaction. Rejecting is always allowed.
create trigger prospect_approvals_guard before insert or update of status on public.approvals
  for each row execute function private.prospect_approval_guard();
```

## 18. Rollback runbook (not a migration)

```sql
-- PROPOSED rollback runbook for Migrations X, B and A (NOT applied, NOT a migration). Reverse dependency order. Every object is new except the one trigger in X,
-- which is the only thing that touches an existing table; dropping it restores that table exactly. Do not run against an environment holding real data without an export.
-- Rollback of X (only if X was applied):
drop trigger if exists prospect_approvals_guard on public.approvals;
drop function if exists private.prospect_approval_guard();
-- Rollback of B (only if B was applied):
drop function if exists public.prospect_retailer_suppressed(uuid);
drop function if exists public.erase_prospect_retailer(uuid);
drop function if exists public.record_prospect_opt_out(uuid, text, text);
drop function if exists public.add_prospect_suppression(uuid, text, text, text);
drop table if exists public.prospect_outreach;
drop table if exists public.prospect_outreach_drafts;
drop table if exists public.prospect_suppressions;
drop function if exists private.prospect_outreach_guard();
drop function if exists private.suppress_retailer(public.retailers, text, uuid);
drop function if exists private.retailer_is_suppressed(uuid, uuid);
drop function if exists private.prospect_draft_hash();
-- Rollback of A:
drop function if exists public.prospect_purge_status(uuid);
drop function if exists public.purge_prospect_cache_now(uuid);
drop function if exists public.purge_prospect_expired(uuid);
drop function if exists private.run_prospect_housekeeping();
drop function if exists private.purge_expired_place_cache();
drop function if exists public.prospect_contact_status(uuid);
drop function if exists public.attest_existing_retailer(uuid, text[], text, date, boolean);
drop function if exists public.decide_prospect_candidate(uuid, text, text);
drop function if exists public.accept_prospect_candidate(uuid, text, text, text, text, text, text, text, text, jsonb, boolean, boolean);
drop function if exists public.set_prospect_stop(uuid, boolean);
drop function if exists public.reserve_prospect_request(uuid, text, text, uuid);
drop table if exists public.prospect_purge_runs;
drop table if exists public.prospect_usage;
drop table if exists public.retailer_contact_sources;
drop table if exists public.prospect_place_cache;
drop table if exists public.prospect_candidates;
drop function if exists private.prospect_candidate_guard();
drop function if exists private.prospect_candidate_auto_guard();
drop table if exists public.prospect_search_units;
drop table if exists public.prospect_campaigns;
drop table if exists public.prospect_locations;
drop table if exists public.prospect_categories;
drop table if exists public.prospect_settings;
drop function if exists private.prospect_fingerprint(text, text, smallint);
drop function if exists private.prospect_hmac(text, smallint, text, text);
drop function if exists private.prospect_normalise(text, text);
drop function if exists private.prospect_key(text, smallint);
drop function if exists private.prospect_key_latest(text);
drop function if exists private.prospect_key_versions(text);
drop function if exists private.prospect_org_live(uuid);
drop function if exists private.is_owner(uuid);
drop function if exists private.prospect_immutable();
```

---

## 19. Final pre-implementation checklist

Five separate groups. Nothing in any group authorises implementation; only the last group does, and only after the middle three are clear.

### 19.1 Documentation complete
- [x] Phase 1 schema proposal v2 (this document), including O26 (section 4.6) and O27 (section 4.8), accepted as the design baseline.
- [x] Security review and decision register: O1 to O27 all decided (`docs/GOOGLE_MAPS_B2B_SECURITY_REVIEW.md`).
- [x] Specification references to this proposal corrected; Phase 0 readiness note updated.
- [x] Migration sequence, pre-flight checks, rollback runbook and test descriptions reconciled with each other (section 10, 11, 18).
- [x] Key custody, rotation, backup and recovery responsibilities written down (section 4.8).

### 19.2 Local SQL validation complete
- [x] 273 checks pass in PGlite (256 main run plus 17 dependency and partial-rollback checks).
- [x] 11 mutations of the SQL each detected.
- [x] Embedded SQL (sections 15 to 18) identical to the validated files.
- [x] Existing tables, policies, grants and triggers unchanged apart from the optional approvals trigger in X (tested).
- Limits: this proves SQL and RLS in PGlite only, not hosted Supabase, concurrency, Vault, `pg_cron` or Realtime.

### 19.3 Legal approval pending
- [ ] **L1 (R1): clearance on Google Maps terms and personal-data retention. Hard blocker.**
- [ ] L2 to L12 as listed in section 9, in particular L4, L8, L12 before Migration B and L11 before production.
- [ ] Native-speaker review of the Hindi and Hinglish scoring terms (O14) is an action, not a legal item, and is also open.

### 19.4 Hosted staging verification pending (blocked on M1 staging)
- [ ] Supabase Vault behaviour (create, read through the key functions, backup and restore), `pgcrypto` schema, who can read Vault.
- [ ] Full role matrix against real Auth claims; `pg_cron` jobs and history (O24, after R2); Realtime exclusion of the cache table; concurrent reservations; statement logging does not capture parameters; backup retention against the 30-day ceiling.
- [ ] Owner generates keys, stores them in staging Vault, takes the offline backup, runs the rotation rehearsal (section 4.8).

### 19.5 Explicit implementation authorisation pending
- [ ] Owner's written go-ahead to turn Migration A into a migration file (after 19.3 R1 and 19.4).
- [ ] Separate go-ahead for the optional seed migration, for Migration B (after counsel on L4, L8, L12) and for Migration X (the one trigger on `approvals`).
- [ ] Separate authorisation for the code remediation set (section 13, O11, including the O26 source-guard test) before Phase 4.
- [ ] Separate authorisation to apply anything to any Supabase project, and to commit, push, merge or deploy.
- Production Supabase is untouched and stays so until all of the above.
