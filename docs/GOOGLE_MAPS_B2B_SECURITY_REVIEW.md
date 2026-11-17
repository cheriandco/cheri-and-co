# Google Maps B2B prospecting: Phase 1 security and schema final review

> **Update 2026-11-16 (decision closure):** the owner approved O1 to O25 with the recommendations above; their application is in `docs/GOOGLE_MAPS_B2B_PHASE1_SCHEMA_PROPOSAL.md` (version 2), which is accepted as the design baseline. Two further decisions arose and are now **decided**: **O26** (no trigger on `retailers`; direct deletion through existing CRM permissions is a documented residual risk; only `erase_prospect_retailer()` deletes within prospecting; no existing retailer policy or permission changes without separate approval) and **O27** (the Cheri & Co. / VEDASRI owner controls independent suppression and provenance keys in Supabase Vault, accessed only through approved database functions, with versioning, rotation, fail-closed behaviour and offline backup; no key in source, Git, prompts or ordinary environment files). Details: proposal sections 4.6 and 4.8. **No O decision remains open; see the register below and proposal section 19.** Where this review's body says "eleven tables" or "a twelfth table", the proposal's final design is thirteen tables (ten in Migration A, three in Migration B).


**Status: REVIEW AND REMEDIATION PLAN ONLY.** No code written, no migration created, no existing table or policy changed, no API connected, no billing, no commit, push or deploy. Date: 2026-11-16. Branch `feature/client-delivery`.

Reviews: `docs/GOOGLE_MAPS_B2B_PHASE1_SCHEMA_PROPOSAL.md` (Migrations A and B), the Phase 2 scoring and Phase 3 Places client under `src/lib/prospecting/`, against the foundation migration, `src/services/live.ts` and the spec.

> **R1 (legal clearance on Google Maps terms and personal-data retention) remains a hard blocker before any database implementation.** Nothing in this review lifts it, and several remedies below add new questions for counsel (section 8).

## 0. Verdict

The Phase 1 proposal is **not ready to become a migration as written.** It holds up on structure, isolation between organisations and the append-only ledger, but this review found real gaps, including several in my own Phase 1 SQL. Each was demonstrated against the scratch database (section 1.2), not just argued.

| # | Finding | Severity | Remedy in short | Changes an existing object? |
|---|---|---|---|---|
| S1 | Demo checks are optional in the client and absent in the database (a demo organisation could create campaigns and reserve spend; `organizations.is_demo` exists and is ignored) | **High** | Required context built by a factory; database refuses demo organisations everywhere | No |
| S2 | Stop-all is optional in the client; a throwing control check surfaces a raw, unclassified error; missing settings are not treated as "stopped" in code | **High** | One required controls reader; any error, absence or non-boolean means stopped | No |
| S3 | Budget reservations and usage events carry no organisation or campaign; **the cost is asserted by the caller, so a caller that says 0 bypasses the cost cap** | **High** | Scope on every call; database computes cost from stored prices | No |
| S4 | Duplicate self-match: once ids are uuids a candidate matches itself | **Medium** (silent loss of leads) | Explicit own-id, and a separate "already known" result | No |
| S5 | Scoring config only shallow-frozen; one in-process mutation changes scoring for every organisation | **Medium** | Recursive freeze, deep-readonly type, pinned config hash | No |
| S6 | Devanagari words are split by the normaliser; Hindi signals never match; zero-width joiners also split words | **Medium** | Keep combining marks, strip joiners, whole-token matching | No |
| S7 | Suppression is not database-enforced | **High** (compliance) | Database-side keyed hashing, enforcement in new tables now, a trigger on `approvals` only if you approve | Tier 2 only |
| S8 | Unkeyed SHA-256 of a phone number is reversible in seconds | **High** for suppression, low for provenance | Keyed HMAC with a purpose-separated key held in Vault | No |
| S9 | **Any viewer can read Google name, address and phone; expired rows stay readable until purged** | **High** | Approvers and above only, and only while fresh, enforced in the policy | No |
| S10 | Personal and business data persists in approvals, audit log and activity history (including existing code that logs business names) | **High** | Drafts table plus shell previews, id-only activity, redaction function, owner-run procedure for history | Partly |

In addition, section 3 lists fifteen further defects found in Phase 1 itself (N1 to N15). Section 7 is the register of every decision that needs your explicit approval.

---

## 1. Method and evidence

### 1.1 Read
`places/client.ts`, `places/budget.ts`, `scoring/duplicates.ts`, `scoring/normalise.ts`, `scoring/config.ts`, `human.ts`, `transient.ts` (this session); the foundation migration (tables, grants, policies, `decide_approval`, `append_only`, `organizations.is_demo`); `src/services/live.ts` (activity logging); `src/lib/auth/access.ts`; and the Phase 1 SQL.

### 1.2 Demonstrated against the scratch database (PGlite, outside the repo)
Probe script against the exact Phase 1 SQL, with these results:

| Probe | Result |
|---|---|
| A demo organisation (`is_demo = true`) creates categories, a campaign, and **reserves spend (`ok`)** | Allowed |
| `reserve_prospect_request(..., estimated_cost = 0, ...)` | `ok`; **21 consecutive reservations moved no cost at all**, so the cost cap never binds |
| Admin flips a `rejected_hard_fact` candidate to `needs_review` | Allowed (it then becomes acceptable) |
| A viewer reads the Google display name and phone | Allowed |
| A viewer reads a cache row whose `expires_at` has passed but has not been purged | Allowed |
| Approver inserts a provenance row directly with an arbitrary fingerprint | Allowed |
| `attest_existing_retailer` writes an activity row | **No** (no audit trail) |
| One approved approval reused to mark two channels `contacted` | Allowed |
| `approval_id` swapped to a pending approval after `contacted` | Allowed |
| Admin deletes a rejected candidate | Allowed |
| Admin raises their own monthly cost cap | Allowed |

### 1.3 Reasoned from reading, not run
Items marked "reasoned" below (for example purge atomicity and concurrency) follow from the code but were not executed. A concurrency test is not possible in PGlite (one connection); see T-B3.

### 1.4 Not verified
Hosted Supabase behaviour, Vault, `pg_cron`, Realtime publication, backup retention, and real Auth claims. All of it waits on M1 staging.

---

## 2. Priority 1: security findings and remediation

### S1. Make demo organisation checks mandatory

**Evidence.** `PlacesClientOptions.demo?: boolean` is optional (`client.ts:24`) and the guard is `if (this.o.demo)` (`:127`), so omitting it fails open. In the database, `organizations.is_demo` already exists (foundation line 30) but no Phase 1 policy or function reads it (probe: a demo organisation reserved spend).

**Risk.** A path that forgets the flag spends real money for a demo organisation, and demo data would mix with real Google calls (FR17 violated).

**Remediation.**
1. **Code (no optional field).** The client is built only by a factory `createPlacesClient(context)` where `context` is produced by one function `loadProspectingContext(orgId)` that reads `organizations.is_demo`, the organisation's settings, and the environment kill switch. The `demo`, `stopAll`, `enabled` fields are **required** in the type, and the constructor also checks at run time that each is a real boolean (types alone can be bypassed by a cast or a JavaScript caller). A missing or non-boolean value throws a fixed-text `misconfigured` error.
2. **Database (defence in depth).** A helper `private.prospect_org_live(org)` returns true only if the organisation exists and `is_demo` is false. It is added to the `with check` of every insert and update policy on the thirteen tables and as the first line of `reserve_prospect_request`, `accept_prospect_candidate`, `attest_existing_retailer`, and Migration B's guard. A demo organisation therefore cannot hold prospecting rows at all.
3. A new `PlacesError` kind `misconfigured` (fixed text, not retryable).

**Needs owner approval:** no (a stricter implementation of FR17), but the policy change is noted in the register (O4).

### S2. Make kill-switch and stop-all checks fail closed

**Evidence.** `isStopped?:` is optional (`:26`), so absence means "not stopped" (fail open). `enabled` is correctly checked with `!== true` (a string "false" fails closed, which is good). If `isStopped()` or `budget.reserve()` throws, the exception propagates unclassified, so the caller receives an arbitrary error object (possibly carrying internals) and the refusal reason is lost. In the database, `reserve_prospect_request` already returns `no_settings` when there is no settings row (good, fails closed) and `stopped`.

**Remediation.**
1. Replace `enabled`, `demo`, `isStopped` with **one required reader**: `readControls(): Promise<{ live: boolean; enabled: boolean; stopAll: boolean }>`. It is awaited **before every attempt** (already per-attempt). **Any** throw, rejection, undefined, missing field, non-boolean value or timeout is treated as stopped and surfaces as `PlacesError("stopped")` with fixed text. The reader gets its own short timeout.
2. The same wrapper applies to `budget.reserve()`: an exception is mapped to `PlacesError("stopped")`, never rethrown raw.
3. The database remains the authority: `reserve_prospect_request` rechecks `stop_all`, campaign status, and caps under lock, so a stale in-process cache of the controls cannot overspend (at most one in-flight request after a stop; documented).
4. **Missing configuration is stop.** No settings row, no environment variable, or an unparseable value all mean disabled. Caps ship at zero (already so in Phase 1).
5. Do **not** add a separate per-organisation "armed" column: zero caps already act as the arming step, and a second switch adds a state to get wrong.

**Needs owner approval:** no.

### S3. Organisation and campaign identity on reservations and usage events

**Evidence.** `ReserveRequest {operation, tier, estimatedCostUsd}` and `UsageEvent {operation, outcome, status, attempt, durationMs, at}` (`budget.ts:24, 31`) carry no organisation, campaign, unit, tier or cost. Separately, `reserve_prospect_request` takes `p_estimated_cost` **from the caller** (Phase 1 SQL), so a caller passing 0 consumes requests without consuming cost (probe: 21 free reservations; the cost cap never binds).

**Remediation.**
1. **Scope on every call.** `searchPage`, `searchAll` and `details` take a required `scope: { orgId, campaignId, unitId? }`. `ReserveRequest` and `UsageEvent` gain `orgId`, `campaignId`, `unitId`, `tier`, `estimatedCostUsd`, `priceBasis`, `reservationId`. A call without scope throws `misconfigured`.
2. **Cost is computed by the database, never accepted from the caller.** Add per-organisation price columns to `prospect_settings` (`price_search_usd`, `price_details_usd`, `price_basis`, `price_verified_at` null until Phase 8) defaulting to the **assumed top-tier prices**, so estimates err high. The function takes `operation` and `tier` only and ignores any caller cost. Prices are changeable only by the owner (O7).
3. The function also validates that `p_unit` belongs to `p_campaign` (the existing composite foreign key proves the unit exists in the organisation, not that it belongs to the campaign: reasoned).
4. The function returns the new ledger id so the client can attach it to the usage event.
5. **Outcomes.** The ledger is append-only, so it cannot record the outcome of a request after the fact. Recommendation: keep the ledger as the **reservation** record (the financial control), keep outcome counts in `prospect_search_units` (`error_code`, `pages_fetched`), and do not add an outcome table in version 1 (O9). A usage sink writing Google content is already forbidden.

**Needs owner approval:** O7, O9.

### S4. Duplicate self-match bug

**Evidence.** `duplicates.ts:37`: `known.filter((k) => !(k.source === "cache" && k.id === place.placeId))` assumes a cache entry's id is its Place ID. With uuid candidate ids the comparison is never true, so the candidate's own cache row is in `others`, and `byId` then returns `DUP_PLACE_ID` against itself. Phone, website and name rules would match it too. Effect: a legitimate new candidate is marked a duplicate of itself and **drops out of review silently**, an integrity loss that no error reports. The Phase 1 check `duplicate_of_candidate_id is distinct from id` is a backstop only for the direct case.

**Remediation.**
1. Signature becomes `detectDuplicate(place, known, { ownCandidateId?, cfg })`. Exclusion is by candidate id only.
2. **A second sighting of the same Place ID is not a duplicate.** `unique (org_id, place_id)` makes it the same candidate. The function returns a distinct result `{ kind: "already_known", candidateId }` (counted for campaign statistics, no new row), versus `{ kind: "duplicate", rule, matchedId, source }` for a **different** record that matches on phone, website domain or name plus locality.
3. A database trigger `prospect_candidates` before insert or update refuses a `duplicate_of_candidate_id` row whose own `place_id` equals the candidate's `place_id` (same-place self reference by another route).
4. Tests T-F1 to T-F5.

**Needs owner approval:** no.

### S5. Deep-freeze the scoring configuration

**Evidence.** `config.ts:41` uses `Object.freeze` on the top object only. Nested arrays (signal lists, thresholds) and objects remain mutable. Because the config is a module-level singleton, one mutation (a bug, a test, a hostile dependency) changes scoring for **every organisation in the process**, a cross-tenant effect.

**Remediation.**
1. A small `deepFreeze` applied at construction (recursive, handles arrays and nested objects), and `ScoringConfig` typed as `DeepReadonly`.
2. Functions that accept a custom config clone and freeze it on entry, so callers cannot retain a mutable alias.
3. A **pinned-hash test**: the canonical JSON of the default config is hashed in the test and compared to a constant; any edit fails until `scoring_version` is bumped and the pin updated deliberately. This ties the stored `scoring_version` to the actual content.
4. A test that mutation attempts throw (in strict mode) or are ignored, and scoring is unchanged afterwards.

**Needs owner approval:** no.

### S6. Hindi and Devanagari normalisation

**Evidence (verified earlier this session).** `normalise.ts:6` ends with `replace(/[^\p{L}\p{N}]+/gu, " ")`. Devanagari vowel signs, the nukta and the virama are combining marks (`\p{M}`), not letters, so they are turned into spaces and a Hindi word is split into fragments; signals never match. Further defects found in this review (reasoned, then to be proven by tests): zero-width joiner and non-joiner (U+200C, U+200D), which Devanagari conjuncts and some Hinglish typists use, are neither letters nor marks and also become spaces; and matching by substring would let a short signal match inside a longer word.

**Remediation.**
1. Keep marks: character class `[^\p{L}\p{M}\p{N}]`.
2. Strip only Latin combining diacritics (U+0300 to U+036F) after `NFKD`, and remove U+200B to U+200D before splitting.
3. Both the input and the signal lists pass through the same function, so Unicode composition differences cancel out.
4. **Whole-token matching** for single-word signals; multi-word signals match as a token sequence, so short signals cannot fire inside longer words.
5. Hinglish: spelling variants are listed explicitly as separate signals (for example the several romanisations of "jewellery"); no fuzzy matching in version 1, because fuzzy matching would be unreviewable.
6. Tests T-H1 to T-H8 (section 5).

**Needs owner approval:** the Hindi and Hinglish word lists themselves need a **native-speaker review** before release (O14).

### S7. Database-enforced suppression and opt-out protection

**Evidence.** Phase 1 stores suppression hashes and offers a lookup function. Nothing in `approvals`, `decide_approval()` or any trigger consults them, and the application computes the hash, so the database cannot check anything itself. FR13 correctly says "application-level", but the owner asked for a database-enforced proposal.

**What can and cannot be enforced.** The system never sends messages ("Contacted" is recorded by a person after sending manually). The database can stop a suppressed contact **entering the approval flow and being recorded as contacted**. It **cannot** stop a person messaging someone off-system. This limit must be stated to the owner and in the FR.

**Options.**

| Option | How | Enforceable? | Cost |
|---|---|---|---|
| A. As Phase 1 | App computes HMAC, DB stores | No | None |
| B. App passes hashes into a definer function that is the only route | Function checks, then creates outreach and approval | Only if direct inserts into `approvals` are blocked, which needs an existing policy changed | Existing object change |
| **C. Database-side keyed hashing (recommended)** | HMAC computed **inside** the database with a key from Vault via one indirection function; one SQL implementation of normalisation; checks in new-table triggers, plus an optional trigger on `approvals` | Yes, for everything routed through the system | Key lives in the database; plaintext passes to the function over TLS |

**Recommended design (Option C).**
1. `private.prospect_key(purpose, version)` is the **only** function that touches the secret store (Vault in hosted, a stub table in local tests). Hosted behaviour is unverified until staging.
2. `private.prospect_suppression_hash(kind, value, version)` normalises (lower-case, trimmed, last ten phone digits, website reduced to host, Instagram handle without "@") and returns `hmac(normalised, key, 'sha256')` as hex. `pgcrypto` supplies `hmac` (availability to be confirmed on staging).
3. `private.retailer_is_suppressed(org, retailer)` hashes the retailer's **current** email, phone, website host and Instagram handle under **every active key version** and checks `prospect_suppressions`.
4. **Tier 1 (new objects only; recommended now):** the `prospect_outreach` guard refuses insert and every move to `approved` or `contacted` for a suppressed retailer. `record_prospect_opt_out(retailer, channel, reason)` (definer) inserts suppressions for **all** the retailer's identifiers and sets `opted_out` in one transaction. `erase_prospect_retailer(retailer)` (definer) inserts suppressions for all identifiers, writes an id-only activity row, and deletes the retailer (cascade) atomically, so suppression always precedes deletion.
5. **Tier 2 (changes an existing table; needs your approval, O1):** a `before insert or update` trigger on `approvals` for rows where `generated_by = 'b2b'` and `meta ->> 'kind' = 'prospect_outreach'`, calling `retailer_is_suppressed` on `meta.ref`. `decide_approval()` approves by `update`, so the trigger fires without altering that function. This closes the "hand-made approval" route for rows that carry the kind marker. An approval created without the marker is not covered; the approvals insert policy allows staff to create any approval, and changing it is a further existing-policy change (O2, not recommended).
6. **Key rotation reality.** A hash cannot be re-hashed, so rotation means adding a new version for **new** rows while old versions stay active for as long as their rows exist. A leaked key means every hash under it must be treated as exposed. Both are stated to the owner.
7. **Lifting a suppression.** Phase 1 made suppressions append-only with no removal path. A mistaken suppression then cannot be undone. Recommendation: **no removal in version 1**, with a manual owner-run procedure for a genuine mistake; the alternative is an owner-only definer function that records the lift in its own append-only table (O3).
8. **Counsel (L4, L5).** Is keyed HMAC acceptable as the retained form; is a suppression retained after the retailer is erased (it must be, to work); is the database-enforced scope above sufficient.

**Needs owner approval:** O1, O2, O3, and counsel.

### S8. Keyed hashing for suppression and provenance fingerprints

**Suppression (required).** The value is retained **after** erasure, so it must resist a dictionary attack. Ten-digit mobile numbers can be exhausted by plain SHA-256 in seconds, and email addresses fall to a wordlist. HMAC with a secret key is the minimum.

**Provenance fingerprint (recommended, lower urgency).** Phase 1 uses unkeyed SHA-256 as a change detector. It sits beside the plaintext value in `retailers` and is deleted with the retailer, so it adds little exposure; the marginal benefit of keying it is defence against a partial leak (for example a leaked `retailer_contact_sources` export without `retailers`). The Phase 1 document called it "not a secret", which is accurate.

**Recommendation.** Key both, with **separate purpose keys** (`suppression`, `provenance`) and separate versions, behind the same `private.prospect_key()` indirection. Provenance acceptance then depends on key availability and **fails closed** (no key, no acceptance). If you prefer simplicity, keep unkeyed fingerprints and record that decision (O6); the change detector still works either way.

**Limits to state.** The key and the hashes live in the same database, so a database administrator can reverse-guess; keyed hashing protects against dumps and exports, not against the database owner. Local tests use a stub key, so they prove logic, not Vault.

**Needs owner approval:** O5, O6.

### S9. Restrict access to the transient Google cache

**Evidence (probes).** Phase 1 lets every member, including viewers, read Google display name, address and phone, and **expired but not yet purged rows remain readable**.

**Remediation.**
1. **Read policy:** `private.can_decide(org_id) and expires_at > now() and private.prospect_org_live(org_id)`. Only approvers, admins and owners can read the cache, and **expiry is enforced at read time**, so even if the purge fails the API stops returning expired data.
2. Staff and viewers see only class P candidate data: score, band, rule codes, decision. The review UI shows Google content only to roles that can decide, which is the only role that needs it.
3. No export, no reporting and no search feature touches the cache.
4. Confirm the cache table is **not in the Realtime publication**, and add a test that fails if it is.
5. Add size limits (`pg_column_size` on `address_components`) so a row cannot hold bulk content.
6. **Backups.** Hosted backups and point-in-time recovery contain cache rows beyond 30 days. Whether that is compatible with Google's terms is a counsel question (L11, new).
7. Direct admin insert and update of cache rows are kept for the runner; there is no non-admin write.

**Needs owner approval:** O8 (staff and viewers lose read access to Google fields), counsel L6 and L11.

### S10. Personal and business data in approvals, audit log and activity history

**Evidence.** `approvals` has `title` (up to 200), `preview` (up to 6,000) and `meta`, **no deletion path for any role**. `audit_log.note` (500) and `agent_activity.action` (500) are append-only by trigger. Existing code writes business names permanently: `Added retailer: <business>` (`live.ts:270`), `Updated retailer: <business>` (`:283`), `Moved <business> to <stage>` (`:298`). These apply to **every** retailer, including prospect-sourced ones, once they are in the CRM.

**Remediation (layered; nothing rewrites append-only history).**
1. **Prevention for new prospecting data.** Prospecting RPCs write fixed, id-only activity text (already so in Phase 1). Prospecting approvals use a **shell** `title` and `preview` (for example "Prospect outreach for retailer <id>, open to review"), `meta` carries only `{ kind, ref, draft_id, draft_sha256 }`.
2. **Drafts in a deletable table** (a third table in Migration B, thirteenth overall, O10): `prospect_outreach_drafts(id, org_id, retailer_id, channel, body, body_sha256, created_by)`. The body is deleted with the retailer (cascade). The approver reviews the body from this table, and the approval is bound to its exact hash (`meta.draft_sha256`), so a later edit cannot change what was approved. Without this table the personal draft text would have to sit in the undeletable approval preview.
3. **`audit_log.note`:** prospecting approvals collect no free-text note in the UI (a code rule). Making the database ignore the note for prospect approvals means changing `decide_approval()`, an existing function (O12, optional).
4. **Existing activity text.** Recommendation: a one-off code change so retailer logging writes `ref_type = 'retailer'`, `ref_id` and fixed text ("Updated a retailer"), and the activity feed resolves names at read time. After that, erasing a retailer leaves anonymous history. This changes existing code paths and the feed's appearance, so it needs approval (O11). It does not rewrite existing rows.
5. **Redaction of old approvals.** A definer function `redact_prospect_approval(approval)` (owner/admin) sets `title`, `preview` and `meta` to fixed redaction text, keeping the row, status and ids. `approvals` is not append-only, so this works without disabling anything. It is a new function operating on an existing table's data, so it needs approval (O13). **Audit-log notes and old activity text cannot be redacted** (append-only); only the manual owner procedure can touch them (L3).
6. **Erasure order.** `erase_prospect_retailer` (S7) suppresses first, then deletes, then redacts the retailer's prospect approvals identified by `meta.ref`.
7. **Retention clock for approvals** (how long a decided approval may keep text) is a counsel question (L3).

**Needs owner approval:** O10, O11, O12, O13, and counsel L2, L3.

---

## 3. Additional defects found in the Phase 1 proposal

These are mine. All were found by re-reading the SQL against the existing schema; the ones marked **(probe)** were demonstrated.

| ID | Defect | Remedy |
|---|---|---|
| N1 | **(probe)** Demo organisations are not blocked in the database | `prospect_org_live()` in policies and functions (S1) |
| N2 | **(probe)** Caller-asserted cost lets the cost cap be bypassed | Database-computed cost (S3) |
| N3 | **(probe)** `auto_outcome` has no state machine: an admin can turn `rejected_hard_fact` or `duplicate` into `needs_review` and then accept | Trigger on the `auto_*` columns: `rejected_hard_fact` is terminal, `duplicate` leaves only through `decide_prospect_candidate`, a decided candidate's `auto_*` are immutable. Residual: the database trusts the application's scoring and an admin could write a forged score; it cannot recompute a score. Stated, not fixable in SQL. |
| N4 | **(probe)** Direct provenance insert with an arbitrary fingerprint | Remove the direct insert grant; provenance is written only by the two definer functions |
| N5 | **(probe)** `attest_existing_retailer` leaves no audit row | Write an id-only `agent_activity` row per call |
| N6 | **(probe)** One approval reusable for several outreach rows | `unique (org_id, approval_id)`; also require the approval's `meta.kind = 'prospect_outreach'` and, with S10, `meta.draft_sha256` equal to the stored draft hash |
| N7 | **(probe)** `approval_id` can be changed after `contacted` | Immutable once set |
| N8 | **(probe)** Admin can delete candidates, erasing the memory of a rejection (and re-enabling rediscovery and re-review) | Remove the delete grant; deletion only through purge or `erase_*` |
| N9 | **(probe)** Admin raises their own spend caps | Caps and prices changeable by the **owner** only (O7) |
| N10 | Outreach states do not match the specification. FR12 lists **eight** (Drafted, Pending Approval, Approved, Contacted, Interested, Not Interested, Follow-up Required, Opted Out). Migration B has six different ones (`replied`, `bounced` are not in FR12) | Reconcile before any migration (O15). Also decide whether one row per retailer and channel (current `unique`) is right, or one row per attempt. Follow-ups need either more rows or a state, not a blocked second insert |
| N11 | Purge is one function and therefore **one transaction**: if a later statement (candidate expiry, token clearing) raises, the **cache deletion rolls back too** (reasoned from plpgsql semantics) | Split into an independent critical step (delete expired cache) and housekeeping steps, each in its own call or exception block; record success or failure |
| N12 | `accept_prospect_candidate` does not check for an existing retailer with the same phone, email or website | Soft duplicate check against `retailers` using the normaliser, refusing unless the caller passes an explicit confirmation |
| N13 | `source_reference` is free text and can itself hold personal data ("spoke to Mr X") | Minimum and maximum length, guidance in the form, deleted with the retailer; counsel to see it (L2) |
| N14 | Re-sightings of a known Place ID by a later campaign are invisible (the candidate belongs to its first campaign), so campaign performance (FR16) undercounts | Either accept the limitation or add an append-only `prospect_sightings` table (O16, recommended **not** in version 1) |
| N15 | Monthly caps use the UTC calendar month; the owner is in India | State in the UI; no schema change |

---

## 4. Priority 2: database design reassessment

### 4.1 The nine Migration A tables

| Table | Verdict | Required changes in A version 2 |
|---|---|---|
| `prospect_settings` | Sound structure | Add price columns (S3); `caps` and prices **owner-only** (N9); `armed` column **not** added; say who creates the row (owner at setup) |
| `prospect_categories` | Sound | Demo gate in policy |
| `prospect_locations` | Sound | Demo gate in policy |
| `prospect_campaigns` | Counter protection works (column grants) | Demo gate; cost cap now computed from DB prices; no admin delete beyond the existing restriction |
| `prospect_search_units` | Sound; one running unit per campaign works | Demo gate; reservation must validate unit-to-campaign (S3) |
| `prospect_candidates` | **Needs work** | `auto_*` state machine (N3); remove delete grant (N8); same-place self-reference trigger (S4); `place_id` regex repetition already fixed (255) |
| `prospect_place_cache` | **Needs work** | Read policy: decide-roles, fresh only, live org (S9); size checks |
| `retailer_contact_sources` | **Needs work** | Remove direct insert (N4); keyed fingerprint decision (S8); activity row on attest (N5); reference length (N13) |
| `prospect_usage` | Sound; append-only, no direct insert | `usage_id` returned; cost DB-derived |

### 4.2 The two deferred Migration B tables, and a proposed third

| Table | Verdict | Required changes in B version 2 |
|---|---|---|
| `prospect_suppressions` | **Redesign** | Database-side keyed hashing via `private.prospect_key()`; multi-version check; opt-out and erase functions (S7); lifting decision (O3) |
| `prospect_outreach` | **Redesign** | Match FR12 states (N10); suppression check on every transition; single-use approval bound to a draft hash (N6); `approval_id` immutable (N7); per-attempt rows decision |
| `prospect_outreach_drafts` (proposed) | New | Holds draft bodies so approvals can stay shell-only (S10, O10) |

Migration B stays separate and deferred until counsel answers L4 to L8.

### 4.3 RLS and tenant isolation

What held up under test: anon denied everywhere; another organisation cannot read, insert, or reference rows (composite foreign keys); definer functions give the same "not found" for missing and other-organisation rows; column privileges stop direct counter and decision writes.

Gaps and changes:
1. **Demo gate** on every policy and function (S1).
2. **Cache read narrowed** and expiry-aware (S9).
3. **Owner-only** for caps, prices and the arming of spend (N9). The foundation has `private.role_in(org)`, so an owner check needs no new role function; a thin `private.is_owner()` wrapper is proposed.
4. **No direct delete** on candidates (N8) and no direct provenance insert (N4).
5. **Policy evaluation cost:** each row calls a definer function; fine at expected volumes (thousands). Revisit with `(select ...)` wrapping if the staging plan shows otherwise.
6. **Realtime and exports:** none of the new tables may enter the Realtime publication (tested on staging).
7. **Privilege boundary for the runner:** it acts as the signed-in admin; there is no service role. This means a campaign cannot run unattended while nobody is signed in (consistent with the spec's "bounded resumable steps").
8. A **definer function reading across organisations** would break isolation; every function begins with a role check on the row's own organisation (checked by review, tested T-X*).

### 4.4 Atomic acceptance and budget reservation

| Function | Holds | Gaps found |
|---|---|---|
| `reserve_prospect_request` | Locks settings then campaign, so concurrent callers queue; no overshoot **by construction** (reasoned; **not** testable in PGlite) | Cost from caller (S3); no demo gate (S1); unit not tied to campaign (S3); no activity or heartbeat on repeated `cap_reached` (fine) |
| `accept_prospect_candidate` | Single transaction; creates retailer, lead, provenance; deletes cache; id-only activity | No duplicate-retailer check (N12); demo gate; keyed fingerprint (S8); source reference length (N13) |
| `decide_prospect_candidate` | Final decisions; closed reason codes | Demo gate; `auto_*` machine interaction (N3) |

A real concurrency test needs a real multi-connection Postgres (staging, or a local container, which would be a new development dependency, O17).

### 4.5 pg_cron retention and deletion

Reassessed design:
1. **Read-time expiry is the first line of defence** (S9): expired rows are invisible to the API whether or not the job runs. The job removes **storage**, not **access**.
2. **Split the job** (N11): step 1, delete expired cache rows (critical, own transaction, small batches with a limit per run); step 2, expire stale candidates and clear stale page tokens (housekeeping, independent).
3. **Make failure visible.** pg_cron keeps run history, but nothing reads it. Add a tiny append-only `prospect_purge_runs` table (a tenth table in A, O18) with time, counts, outcome, and have the app show "purge overdue" when the oldest expired cache row is older than a threshold (query, no schema needed beyond the table). Also run the same function lazily at the start of every prospecting request, so use of the system also purges.
4. **Fail loudly, not silently:** the scheduler job's failure must not be the only record that it failed.
5. Schedule frequency hourly; the job runs as the database owner (no `auth.uid()`), which is why the purge functions have no grant to API roles.
6. **Backups and replicas** retain expired rows beyond the purge (L11).
7. **The schedule is a separate migration** after R2 and L10 approval, never bundled.

### 4.6 Provenance and independently sourced CRM records

Strengths: closed source list, no `google_places`, per-field rows, attestation with identity and time, value-changed marker, `existing_crm` path, review dates.

Weaknesses found and remedies:
1. **Attestation is self-assertion.** The database cannot prove a value did not first appear on Google. The controls are the closed list, the required reference, attestation, audit rows, refusal to pre-fill, and expiry. Whether that suffices is L1.
2. **`existing_crm` can launder Google-derived values already typed into the CRM.** Mitigations: per-retailer only (no bulk function), a required reference, an audit row per call (N5), a short default review period, and a one-time **owner** review of any batch attested in one sitting (an application report, not schema).
3. **Direct insert path** removed (N4).
4. **Fingerprint** keyed or kept simple per S8.
5. **`source_reference`** may hold personal text (N13).
6. **Erasure of a retailer deletes its provenance** (cascade). That removes evidence of how data was sourced, which is the intended trade (erasure wins) but should be stated: provenance is not an audit trail after erasure; the id-only activity row is.

---

## 5. Priority 3: test specification

Test levels: **U** unit (Vitest), **S** SQL (PGlite, the M5 harness with the stub roles), **H** hosted staging only (blocked until M1), **R** manual review. All SQL tests also confirm existing tables are unchanged.

### 5.1 Cross-organisation access (S)
| ID | Test | Expected |
|---|---|---|
| T-X1 | Organisation B member selects every new table | Zero rows |
| T-X2 | B inserts into A's table with A's `org_id` | RLS refusal |
| T-X3 | B inserts a row in B that references A's campaign, candidate, retailer or approval | Foreign-key refusal (composite) |
| T-X4 | B calls each definer function with A's ids | "not found" and **the same message** as for a nonexistent id |
| T-X5 | Anon and a user with no membership call every function | Denied |
| T-X6 | A staff user in A calls `reserve`, `accept`, `decide`, `attest`, `purge_now` | Refused with the role-appropriate error |
| T-X7 | `prospect_contact_status` for another organisation's retailer | Zero rows |
| T-X8 | Cache read as viewer, staff (after S9) | Zero rows; approver sees fresh rows only |
| T-X9 | Two organisations score the same Place ID | Independent candidates; no cross-reference |

### 5.2 Demo organisation refusal (U, S)
| ID | Test | Expected |
|---|---|---|
| T-D1 | U: build a client with `demo` omitted, `undefined`, `"false"`, `1` | Constructor throws `misconfigured`; transport never called |
| T-D2 | U: `demo: true` | `PlacesError("demo")`, transport and budget never called |
| T-D3 | S: demo org inserts into each new table | Refused |
| T-D4 | S: `reserve`, `accept`, `attest` in a demo org | Refused |
| T-D5 | U: guard test greps that no code path constructs the client except the factory | Fails on a second construction site |

### 5.3 Missing kill-switch configuration (U, S)
| ID | Test | Expected |
|---|---|---|
| T-K1 | U: env variable absent, empty, `"false"`, `"TRUE"`, `"1"` | Only exact `true` enables; others refuse |
| T-K2 | U: controls reader throws, rejects, times out, returns undefined, or a missing field | `stopped`, fixed text, transport never called |
| T-K3 | U: `budget.reserve` throws | `stopped`, not a raw error |
| T-K4 | S: no settings row | `reserve` returns `no_settings`; nothing spent |
| T-K5 | S: `stop_all = true` mid-run | Next reserve returns `stopped` |
| T-K6 | U: stop flips between two attempts of one retry loop | Second attempt refused |
| T-K7 | U: error text for every refusal never contains a key, name or URL | Fixed strings only |

### 5.4 Budget exhaustion and concurrent reservations
| ID | Level | Test | Expected |
|---|---|---|---|
| T-B1 | S | Campaign request cap, campaign cost cap, monthly request cap, monthly cost cap each reached | `cap_reached`, counters at most the cap |
| T-B2 | S | Caller passes cost 0 or a negative or inflated cost (after S3) | Ignored; database price applies; counters move by the stored price |
| T-B3 | **H** | N parallel connections each call `reserve` until refusal | Exactly `cap` successes; counter equals ledger row count |
| T-B4 | S | Reserve for a unit of another campaign | Refused |
| T-B5 | S | Ledger update, delete, direct insert | Refused |
| T-B6 | U | A failing request is still counted; retries each reserve | Counter equals attempts |
| T-B7 | S | Month boundary: rows at 23:59:59 UTC and 00:00:01 | Counted in the correct month |
| T-B8 | S | Owner vs admin changing caps (after N9) | Admin refused |

### 5.5 Suppressed contact attempting outreach (S, H)
| ID | Test | Expected |
|---|---|---|
| T-U1 | Suppress the email hash, then insert outreach for that retailer | Refused |
| T-U2 | Suppress by phone (different formatting), then draft | Refused (normalisation equal) |
| T-U3 | Suppress a website host, retailer with a different path | Refused |
| T-U4 | Suppression under key version 1, then key version 2 added | Still refused (every version checked) |
| T-U5 | Retailer edits their email after suppression | The new email is not suppressed; the **old** hash remains; documented behaviour |
| T-U6 | `record_prospect_opt_out` | All identifiers suppressed, status `opted_out`, then no further rows |
| T-U7 | Tier 2: hand-made `approvals` row with the prospect kind, then `decide_approval` | Refused |
| T-U8 | Tier 2: an approval **without** the kind marker | **Not blocked** (documented limit); asserted so nobody believes otherwise |
| T-U9 | Suppression table has no plaintext column; non-hex refused; append-only | Pass |
| T-U10 | `erase_prospect_retailer` | Suppressions present **before** the retailer disappears; one transaction |
| T-U11 | Missing key | Suppression insert and check **fail closed** (refuse), never skip |

### 5.6 Candidate duplicate self-match (U, S)
| ID | Test | Expected |
|---|---|---|
| T-F1 | U: candidate's own cache row present in `known` with uuid id | No duplicate result |
| T-F2 | U: same Place ID seen twice | `already_known`, no new candidate |
| T-F3 | U: different Place ID, same phone | `duplicate` with the other id |
| T-F4 | U: own row plus a true duplicate | The true duplicate is returned |
| T-F5 | U: first sighting with no own id | No self-match |
| T-F6 | S: `duplicate_of_candidate_id = id` | Refused |
| T-F7 | S: duplicate target with the same `place_id` | Refused |

### 5.7 Hindi and Hinglish business names (U)
| ID | Input (invented businesses) | Expected |
|---|---|---|
| T-H1 | A Devanagari name with vowel signs and a conjunct, for example a "Shri Radhe Jewellers" name written in Devanagari | Normalised as one token per word; **no word split**; signal matches |
| T-H2 | The same name with zero-width joiners inserted | Same normalised result |
| T-H3 | Composed and decomposed Unicode forms of the same word | Equal after normalisation |
| T-H4 | Hinglish: several spelling variants of "jewellery" and of a gifting term | Each listed variant matches; unlisted variant earns **no** points (unknown earns zero) |
| T-H5 | Mixed script ("Radhe ज्वेलर्स") | Both parts matched |
| T-H6 | Short signal inside a longer unrelated word | **No** match (whole-token) |
| T-H7 | Devanagari digits and punctuation | Treated as digits and separators |
| T-H8 | Duplicate detection on Devanagari name plus locality | Equal names match, different names do not |
| T-H9 | A pinned test that the normaliser never returns a string containing U+200B to U+200D | Pass |
| T-H10 | R: native-speaker review of the Hindi and Hinglish lists | Signed off (O14) |

### 5.8 Personal-data deletion and retention (S, R)
| ID | Test | Expected |
|---|---|---|
| T-P1 | **Taint test:** a unique sentinel string as the fake Google name, phone, website; run the whole flow | Found **only** in `prospect_place_cache`, and nowhere after purge or acceptance |
| T-P2 | Accept, then erase the retailer through `erase_prospect_retailer` | Retailer, lead, provenance, outreach, drafts gone; cache gone; suppression present; one id-only activity row |
| T-P3 | Search every text column of every table for the retailer's name and phone after erasure | Not found except in tables that are append-only or approvals **from before Phase 1**; the list of those is asserted exactly |
| T-P4 | New prospecting approvals | `title`, `preview` and `meta` contain no name, phone or email (regex and sentinel check) |
| T-P5 | `redact_prospect_approval` | Text replaced, row and status kept |
| T-P6 | Prospecting RPCs' activity text | Fixed strings; contains no business text |
| T-P7 | `audit_log` and `agent_activity` update and delete | Refused (append-only, unchanged) |
| T-P8 | Draft body deleted with the retailer; approval's draft hash cannot be satisfied afterwards | Contact refused |
| T-P9 | Source reference bounds and the purge of unreviewed candidates by age | Pass |
| T-P10 | R: counsel's answers on L2, L3 recorded | Required before release |

### 5.9 Cache expiry and purge failure (S, H)
| ID | Test | Expected |
|---|---|---|
| T-E1 | Insert 7-day, 30-day, 31-day, and past `expires_at` | 7 and 30 pass; 31 and past refused |
| T-E2 | Expired but unpurged row | **Invisible** to API roles (read policy), still present to the owner |
| T-E3 | Purge deletes expired rows; fresh rows kept | Pass |
| T-E4 | Make the housekeeping step raise | The cache deletion step **still committed** (after N11) |
| T-E5 | Make the whole job raise or not run | Expired rows invisible (T-E2); `prospect_purge_runs` shows failure; the app's "purge overdue" query returns true |
| T-E6 | Page token on a finished unit refused; stale token cleared | Pass |
| T-E7 | "Purge now" by admin removes only own organisation | Pass |
| T-E8 | Purge functions not executable by API roles | Denied |
| T-E9 | H: `pg_cron` job exists, runs, and its history is readable; job failure is detectable | Pass on staging |
| T-E10 | H: cache table not in the Realtime publication | Pass on staging |
| T-E11 | H: backup and PITR retention documented against the 30-day ceiling | Recorded (L11) |

### 5.10 Cross-cutting
- **Mutation checks** scripted into the suite: each security-relevant check (30-day ceiling, column grants, source type list, cap check, approval check, role check, demo gate, read policy, `auto_*` machine) is removed in turn and the suite must fail.
- **Drift test:** each migration file equals its SQL block in the proposal document (the M5 pattern).
- **Source guards:** no Google host outside the transport, no send API anywhere, no construction of the client outside the factory.
- **Role matrix** table-driven for all five roles across all thirteen tables and every function.

---

## 6. Resulting changes to the plan (no files written)

1. **Phase 1 proposal v2** (delivered 2026-11-16 and accepted as baseline): changes to A and B, a key-custody section (4.8) for Vault and `pgcrypto`, and the stub strategy. Final design: thirteen tables (ten in A, three in B).
2. **Migration X (changes to existing objects)** is **separate and optional** and holds **only the `approvals` trigger** (O1). The `decide_approval` note change (O12) was not taken (a UI rule instead), and approval redaction lives inside `erase_prospect_retailer()` (O13), a new function, not in X. It is applied only on a separate go-ahead.
3. **Code remediation set** (Phase 2/3 fixes S1 to S6) is a separate authorised task, before Phase 4. It does not need the database.
4. **Phase 4 stays blocked** on R1, approval of A version 2, and the code set.
5. The Phase 1 proposal carries a pointer to this review (its header and section 1).

---

## 7. Schema decisions requiring explicit owner approval

The recommendation is mine; each needs your yes, no or change.

| ID | Decision | Recommendation | Existing object? |
|---|---|---|---|
| O1 | Add a `before insert or update` trigger on `approvals` enforcing suppression for the prospect kind | **Yes**, it is the only way to make FR13 database-enforced | **Yes: existing table** |
| O2 | Restrict who may insert approvals (existing policy) so the kind marker cannot be omitted | **No**; too invasive | **Yes: existing policy** |
| O3 | Suppression removal: none in version 1 (manual owner procedure) vs an owner-only lift function | None in version 1 | No |
| O4 | `prospect_org_live()` demo gate in all new policies and functions | **Yes** | No |
| O5 | Database-side HMAC with the key in Vault (Option C), versioned, purpose-separated | **Yes**, subject to staging verification of Vault and `pgcrypto` | No |
| O6 | Key the provenance fingerprint too, or keep unkeyed SHA-256 | Key it (separate purpose key); simplicity is an acceptable alternative | No |
| O7 | Caps and prices changeable by the **owner only**; prices stored in settings; cost computed by the database | **Yes** | No |
| O8 | Cache readable by approver and above only, fresh rows only | **Yes** | No |
| O9 | No usage-outcome table in version 1; reservation ledger only | **Yes** | No |
| O10 | Add `prospect_outreach_drafts` (draft text outside approvals; approval holds shell text and a draft hash) | **Yes** | No (new table) |
| O11 | Change existing retailer logging to id-only activity text and resolve names at read time | **Yes**, separate code task | **Yes: existing code** |
| O12 | Change `decide_approval()` to ignore free-text notes on prospect approvals | Optional; prefer a UI rule | **Yes: existing function** |
| O13 | Add `redact_prospect_approval()` for old approvals | **Yes** | New function acting on existing data |
| O14 | Native-speaker review of Hindi and Hinglish signal lists before release | **Yes** | No |
| O15 | Align `prospect_outreach` states with FR12's eight, and decide one row per retailer and channel vs per attempt | Match FR12; one row per attempt | No |
| O16 | `prospect_sightings` for re-sightings | **No** in version 1 | No |
| O17 | A local multi-connection Postgres (container) for the concurrency test, vs staging only | Staging only, no new dependency | No |
| O18 | `prospect_purge_runs` table (the tenth table in A) for visible purge failure | **Yes** | No |
| O19 | Candidate and provenance delete grants removed; deletion only via purge or `erase_*` | **Yes** | No |
| O20 | Direct provenance insert removed; the two functions are the only writers | **Yes** | No |
| O21 | Duplicate-retailer soft check in acceptance | **Yes** | No |
| O22 | Split the purge into critical and housekeeping steps | **Yes** | No |
| O23 | Whether staff may create outreach drafts at all (Phase 7) or only approvers | Staff may draft; approvers approve | No |
| O24 | Apply `pg_cron` for the purge (R2 and L10) | Yes, after staging verification | Adds scheduled infrastructure |
| O25 | Accept the stated limits: the database cannot stop off-system messaging, cannot recompute scores, and cannot protect against its own administrator | Acknowledge | n/a |

| O26 | Add a before-delete trigger on `retailers` that suppresses automatically | **No** (decided 2026-11-16); document direct deletion through existing CRM permissions as a residual risk | **Would be: existing table; not taken** |
| O27 | Who controls, generates, stores, backs up and rotates the Vault keys | **The Cheri & Co. / VEDASRI owner**, independent keys in Vault, database-function access only, versioned (decided 2026-11-16) | No (owner action outside the schema) |

Counsel questions carried forward and added: **L1 to L10** from the Phase 1 proposal, plus **L11** (backup and recovery retention against the 30-day ceiling) and **L12** (whether retaining keyed suppression hashes for people who asked to be forgotten is lawful, and for how long).

### Decision status after closure (2026-11-16)

All of O1 to O27 are decided. "Approved" means approved with my recommendation and applied in the proposal v2 (section numbers refer to it). Some decisions still gate later work, listed in the last column.

| ID | Outcome | Where | Still gates |
|---|---|---|---|
| O1 | Approved: one `approvals` trigger | Migration X, 17 | Separate go-ahead to apply X |
| O2 | Not taken (approvals insert policy unchanged) | 4.7, 17 | none; limit stated: an approval without the `prospect_outreach` marker is not covered |
| O3 | Approved: no suppression removal in version 1 | 4.6 | none |
| O4 to O10 | Approved and applied | 4.1 to 4.4, 3 | none |
| O11 | Approved; **code task, not done** | 13 | Separate code authorisation, before Phase 4 |
| O12 | Not taken; UI rule instead (no free-text note on prospect approvals) | 13 | UI rule is part of the code task |
| O13 | Approved; realised inside `erase_prospect_retailer()` (redacts approvals whose `meta.ref` matches), not as a separate function | 4.6, 16 | none |
| O14 | Approved; **native-speaker review is an action still to do** | 13 | Before release of scoring |
| O15 | Approved and applied (FR12's eight states, one row per attempt) | 4.7 | none |
| O16 | Not taken in version 1 | none | none |
| O17 | Staging only | 11, 19.4 | Needs M1 staging |
| O18 to O23 | Approved and applied | 3, 4, 7, 8 | none |
| O24 | Approved in principle: `pg_cron` after staging verification and R2 | 8, 10 | Staging plus R2 |
| O25 | Limits acknowledged | 4.5, 11 | none |
| O26 | **Decided:** no trigger on `retailers`; residual risk documented; only `erase_prospect_retailer()` deletes within prospecting; no change to existing retailer policies without separate approval | 4.6 | Source-guard test with the code task |
| O27 | **Decided:** owner-controlled independent keys in Vault, function-only access, versioning, rotation, fail closed, offline backup, nothing in source, Git, prompts or environment files | 4.8 | Owner generates and stores keys on staging, then production |

**Unresolved O decisions: none.** What is not yet settled is not an O decision: legal L1 to L12 (counsel and owner), the gated items in the last column, and these baseline-implicit points, which the owner can overrule at any time: (1) a hard-fact rejection is terminal in version 1 (4.5); (2) Migration X needs its own go-ahead (O1); (3) the seed migration of categories and cities is optional.

Cross-reference corrections made at closure: the proposal's table count is thirteen (ten in A, three in B) rather than eleven or twelve; Migration X holds only the approvals trigger; the specification's FR2 now points at proposal section 3 and 13; the Phase 0 note now says ten tables in A and three in B.

---

## 8. What blocks implementation

1. **R1 legal clearance** (hard blocker).
2. Counsel's answers L1 to L12 (your decisions O1 to O27 are all made).
3. Phase 2/3 code remediation S1 to S6 (and O11, O26 source-guard test) authorised, built and tested.
4. The owner's key custody steps (O27) done on staging first.
5. M1 staging resumed (needed for Vault, `pgcrypto`, `pg_cron`, Realtime, concurrency and hosted RLS evidence). Until then everything database-side is proven only in PGlite.

## 9. What this review does not claim

- It does not claim Vault, `pgcrypto` or `pg_cron` behave as described on hosted Supabase; that is unverified.
- It does not claim concurrency safety is proven: the locking argument is sound but untested.
- It does not claim the scoring is right, only that the database cannot check it.
- It does not claim legal compliance; every legal point is a question for counsel.
- The probe results in 1.2 prove behaviour of the Phase 1 SQL in PGlite only.
