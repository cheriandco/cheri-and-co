# Google Maps B2B lead generation (specification, revision 2, NOT built)

Status: **specification only.** No code, schema, migration, dependency or configuration has been added, no existing table has been changed, and nothing has been connected to Google. No billing has been activated and no paid call has been made.
Every statement about Google's API, pricing, quotas and terms is marked **(unverified)** where it comes from my general knowledge rather than from a live call or a current Google document. Statements about Indian law are **not legal advice**; they must be confirmed by counsel before the module goes live.
Brand context: Cheri & Co., a brand of VEDASRI (owner-stated; not recorded elsewhere in the repository).

## 0. Revision 2: decisions applied
| Decision | Applied as |
|---|---|
| **D1** strict Google compliance | Google-sourced content is **transient** (a short-lived cache with a database-enforced maximum age). Only the **Place ID** and our own decisions persist. Permanent CRM data comes from a **separate, independently sourced process** with recorded provenance. Retention and deletion controls added (section 6.6). |
| **D2** human approval before CRM | The system **never** creates a retailer or lead. A person with approval rights does, through an acceptance step. The word "Qualified" now means *accepted by a person*. |
| **D3** Google Cloud ownership | Project and billing belong to Cheri & Co./VEDASRI; setup checklist in section 5.8; nothing is created under a developer account. |
| **D4** spending | Pilot budget, a hard cap enforced at three layers, usage ledger, emergency stop, and **billing stays off until you approve** (sections 5.7, 9). |
| **D5** outreach | Every first contact goes through the existing approvals workflow; nothing is sent by the system. Drafts are built **only** from independent CRM data, never from Google content. |
| **D6 to D9** conservative defaults | No automatic qualification from assumptions: automation only **prioritises** and only auto-rejects on hard verified facts. No website reading, no AI, no enrichment in the first version. See section 11. |
| Items 1 to 5 | Schema reconciled (section 6), transient and permanent data separated (section 6.2), lawful retention explained (section 8.1), the 50 to 100 target revisited (section 9.3), five-agent architecture unchanged (section 1.3). |

---

## 1. Existing implementation assessment

### 1.1 What exists today (verified by reading the code)
| Area | State | Where |
|---|---|---|
| B2B Lead Agent page | `/b2b`: retailer table by temperature, pipeline funnel, activity feed. For a **live** organisation the discovery panel and follow-up recommendations are **hidden** (SAMPLE only). | `src/app/(app)/b2b/page.tsx` |
| Discovery | **Sample only**: `GET/POST /api/b2b/discover` returns six invented candidates; "No search is run anywhere". | `src/app/api/b2b/discover/route.ts`, `src/mocks/agent-samples.ts` |
| Qualification | Two rule-based scorers over sample data plus `temperatureFor` (HOT ≥ 75, WARM ≥ 55, else COLD). Weights and factors (Instagram, last activity) differ from this spec. | `src/lib/agent-logic.ts` |
| CRM tables | `retailers` (business, location, category, contact, email, phone, instagram, website, qualification) and `leads` (stage, score 0–100, temperature, owner). Composite FK keeps a lead in its organisation. **`retailers` has no unique key** except `(org_id, id)`. | foundation migration |
| Creating retailers | `liveCreateRetailer` creates the retailer and a lead at stage `new`; **API only, no form**. It logs "Added retailer: <business name>" into `agent_activity`. | `src/services/live.ts` |
| Duplicate detection | CSV import (M2) keys retailers by `business|location`, email, last-10-digit phone. Nothing dedupes by Google Place ID. | `src/lib/import.ts` |
| Approvals | `approvals` (pending/approved/rejected/executed; **`preview` and `meta` persist**), `decide_approval()` with role check and an `audit_log` row (approval-only: `approval_id` is required), claim guard at queue and decision time. B2B follow-up already queues type "B2B outreach". Approving records a decision only. | `src/services/live.ts`, foundation migration |
| Outreach drafting | A plain template (`liveFollowUpDraft`) from a retailer record; states no prices or claims; "Nothing has been sent". | `src/lib/agent-logic.ts` |
| Activity and tasks | `agent_activity` (append-only: agent, action text, ref, actor), `tasks`. | foundation migration |
| Roles | owner, admin, approver, staff, viewer; `deny(permission, req)` handles 401/403/CSRF. | `src/lib/auth/` |
| UI kit | `PageHeader`, `DashboardCard`, `Tabs` (`?tab=`), `FilterBar`, `DataTable`, `StatusBadge`, `Score`, `EmptyState`, `SimBadge`. | `src/components/ui.tsx` |
| Reusable M5 patterns | Bounded, resumable, browser-driven steps (no background infrastructure); `waiting` instead of sleeping; repo bound to one organisation; whitelist mappers; redaction; scope-immutability and guard triggers; PGlite SQL tests; source guards confining an external host to one folder. | `src/lib/amazon/`, `docs/M5_*.md` |

### 1.2 What is missing
A Places client and cost controls; campaign, city and category configuration; candidate tracking by Place ID; a transient store for Google content with enforced expiry; an evidence-based prioritiser; a review and acceptance step; provenance for contact details; outreach states beyond the pipeline stage; an opt-out list; retention and erasure controls.

### 1.3 Constraints
- `docs/FINAL_DELIVERY_ROADMAP.md` section J lists "Google Places discovery" and new dashboard modules as out of scope without written approval. I have **not** edited it (decision R9 below).
- `docs/BUSINESS_CONTEXT.md`: B2B WhatsApp messages are prepared for a human to send, never auto-sent.
- **Five-agent architecture unchanged.** The capability lives entirely inside the **B2B Lead Agent**. It adds no agent, no orchestrator role and no new agent key. The AI Business Orchestrator remains a coordination layer that may read counts (candidates awaiting review, leads accepted); it does not run searches. The agent key `b2b` is used for activity and approvals as today.
- A latent hazard found: existing code writes business names into `agent_activity` ("Added retailer: <name>"). That is fine for independently sourced CRM data, but **this module must never log Google-sourced names**, because activity rows are permanent and append-only.

---

## 2. Functional requirements
Priority: **M** must, **S** should, **C** could.

| ID | Requirement | P |
|---|---|---|
| FR1 | Owner/admin creates a **prospecting campaign** (categories, locations, hard caps). | M |
| FR2 | Categories and search terms are **configurable data**, seeded with the eight categories in the brief. **Signal-word lists (English, Hindi, Hinglish) live in versioned code, not in the database** (Phase 1 proposal v2, section 3, table `prospect_categories`, and section 13); the database records only which scoring version produced a score. | M |
| FR3 | Locations are **configurable data**, seeded with the Madhya Pradesh cities in the brief; any Indian city can be added. | M |
| FR4 | Searches use only the official Places API, server-side, as bounded resumable steps. No scraping, no browser automation. | M |
| FR5 | Candidates are tracked by **Place ID**; duplicates are linked, never deleted; fuzzy duplicate checks use transient data and the CRM and store no Google content. | M |
| FR6 | Each candidate gets a **priority score** with per-criterion points and reasons. Unknown evidence earns nothing. | M |
| FR7 | Automatic outcomes are limited to: Needs Review, Insufficient Information, Duplicate, and Rejected **only on a hard verified fact** (permanently closed, outside configured locations). | M |
| FR8 | **Only a person** (approver, admin or owner) can accept a candidate. Acceptance creates the retailer and lead from **independently sourced** details with recorded provenance. | M |
| FR9 | Google-sourced fields expire automatically; expired data is deleted, not hidden. Admin can purge on demand. The 30-day ceiling is a database check; physical deletion needs the purge function to run (a scheduled job is a separate approval, R2) and, until then, the lazy purge plus the admin "Purge now" action. | M |
| FR10 | Outreach drafts are built only from independent CRM data, with contact source and channel recorded and consent/privacy checks displayed. | M |
| FR11 | Every first contact goes through the **existing approval queue**; the system never sends WhatsApp, email or any message. | M |
| FR12 | Outreach states are tracked: Drafted, Pending Approval, Approved, Contacted, Interested, Not Interested, Follow-up Required, Opted Out. "Contacted" is recorded by a person after sending manually. | M |
| FR13 | An opt-out (suppression) list blocks drafting and approval. **Database-enforced for everything routed through the system (Phase 1 v2):** an outreach attempt cannot be created or advanced, and (optional Migration X) a prospect-outreach approval cannot be created or approved, for a suppressed retailer; the check uses keyed hashes computed in the database and **fails closed** if the key is missing. **Not covered:** an approval created without the `prospect_outreach` marker, and any message a person sends outside the system. | M |
| FR14 | Cost controls: estimate before run, hard caps, usage ledger, emergency stop, environment kill switch (default off). | M |
| FR15 | Erasure on request, and review prompts for stale prospect data. **Erasure is partial by design today:** `erase_prospect_retailer()` suppresses, redacts linked approvals and deletes the retailer, but append-only `agent_activity` and `audit_log` rows, and approvals that do not point at the retailer, cannot be erased by the application. Section 6.6 states the position; R1 counsel review is still open on it. | M |
| FR16 | Campaign performance metrics, including reviewer workload and acceptance rate. | S |
| FR17 | Demo organisations see SAMPLE data only; **no Google call is ever made for them.** | M |
| FR18, FR19 | Website reading and AI assistance. **Not in the first version** (section 5.9). | C |

---

## 3. Proposed user workflow
New permissions (proposed): `prospecting:run` (owner, admin) for searches and settings; acceptance and rejection use the existing `approvals:decide` roles (owner, admin, approver).

| # | Step | Who | What happens |
|---|---|---|---|
| 1 | Create campaign | owner/admin | Name, categories, locations, hard caps. Draft only; nothing searched. |
| 2 | Estimate and confirm | owner/admin | The app shows maximum requests and an estimated cost against the remaining budget. Nothing is called until Run is pressed, and only if the environment switch is on. |
| 3 | Search | system, browser-driven | Bounded steps per unit (term × city). Progress is shown; throttling is "waiting". Stops at any cap or on the emergency stop. |
| 4 | Candidates | system | Each result is recorded by **Place ID**. A Place ID already known is not rediscovered. |
| 5 | Duplicate check | system | Place ID; then transient fields and the CRM (compared in memory, nothing stored); results saved as links only. |
| 6 | Details for survivors | system | A narrow second call only for non-duplicates that pass the geography/status pre-filter. Results go to the **transient cache** with an expiry. |
| 7 | Prioritise | system | Rubric over the transient fields. Stored: points and rule codes, not text. |
| 8 | Review queue | staff and above | Candidates appear with a priority band. The reviewer opens the business on Google Maps (their own link, in Google's interface), looks at the business's **own** channels, and decides. |
| 9 | Independent details | approver+ | To accept, the approver enters the business's details **from independent sources** (section 6.4) with the source recorded and an attestation. The form **never pre-fills from Google data**. |
| 10 | Accept = CRM entry | approver+ | One human action creates the `retailer` and `lead` (stage `new`), writes provenance, links the candidate, logs an activity row with ids only. |
| 11 | Reject / Needs more info | approver+ | Recorded with a short reason. A rejected Place ID is remembered so it is not re-reviewed. |
| 12 | Draft outreach | staff and above | Template draft from the retailer record and its recorded source. Suppression and consent checks run first. |
| 13 | Approve | approver+ | The existing Approvals page. Approving records a decision only. |
| 14 | Contact | **a person**, outside the app | Sends manually, then marks "Contacted". |
| 15 | Track | staff and above | Interested / Not Interested / Follow-up Required / Opted Out; follow-ups become tasks. |

---

## 4. Prioritisation and scoring specification

### 4.1 Principles (conservative, per D6)
1. **The score prioritises; people qualify.** The system never sets "Qualified". It sets a priority band to order the review queue.
2. **Evidence grades.** **V** a fact Google returned (for example business status); **I** an inference from a type label or a keyword in the name (a *signal*, worth fewer points, never a conclusion); **H** a person confirmed it; **U** unknown, **zero points**, listed as unknown.
3. **Google cannot see the assortment.** Whether a shop sells imitation jewellery, or whether a "jewellery store" is gold-only, is invisible to the data. The rubric caps automation accordingly.
4. **Deterministic and reproducible:** same inputs, same score. Weights and keyword lists are versioned configuration; the version is stored with each score.
5. **Strict storage.** The score's per-criterion **points and rule codes** are stored (for example `CAT_TYPE_AND_NAME_SIGNAL`); the Google text that produced them is **not**. While the transient cache is fresh the UI can show the reasons in words; afterwards it shows the codes' descriptions and "refresh to view details". Whether even these derived codes are permitted is a question for counsel (R1); the fallback is to store only the band and total.

### 4.2 Rubric (100 points)

| Criterion (max) | How it is evaluated | Points |
|---|---|---|
| **Product-category fit (30)** | Google primary type and types; name against the campaign's signal words (editable list, for example imitation, artificial, fashion, fancy, ladies, accessories, novelty, gift, boutique). | 30 a person confirmed it sells fashion or imitation jewellery or women's accessories (H). 24 a jewellery, gift, clothing or cosmetics type **and** a signal word (V+I). 16 a relevant type, no signal word (I). 8 a signal word with a generic store type (I). 0 no evidence. **Automation cap: 24.** |
| **Assortment compatibility (25)** | Plausibility of everyday, CZ/AD or gifting pieces. Google gives no stock data. | Up to 8 from name or type signals for everyday fashion or gifting (I). Up to 17 more **only** from a person's confirmation (H). Otherwise 0. **Automation cap: 8.** |
| **Business-model fit (15)** | Physical retail with an address; gift, boutique or multi-brand indicators; online-reseller evidence. | 15 physical retailer, gift shop or multi-brand store by type and street address (V). 10 retail type, thin address. 5 reseller evidence without a shop. 0 none. |
| **Geographic fit (10)** | Address components against the campaign's locations. | 10 target city (V). 6 target state, other city. 3 configured expansion area. 0 outside or unknown. |
| **Business activity (10)** | `businessStatus` and rating count. "New venture" never comes from Google. | 6 operational (V), plus 2 for at least 1 rating, plus 4 for at least 10 (cap 10). Temporarily closed 0 and flagged. A person's "new venture" note (H) up to 4. |
| **Contactability and evidence quality (10)** | Whether a public contact route exists, and how much rests on V evidence. Stored only as yes/no flags. | 4 a phone is listed. 2 a website is listed. 2 at least four criteria rest on V/H evidence. 1 complete address. 1 details fetched within the cache window. |
| **Total** | | **100** |

**Maximum an unreviewed candidate can reach: 77.** A higher score means a person added evidence.

**Implementation notes (Phases 2 and 3, `src/lib/prospecting/scoring/`).** Where the table was open to interpretation, the code does this, and the worked examples in 4.4 reproduce exactly:
- Signal words come in two lists. *Category* words (imitation, artificial, fashion, fancy, ladies, accessories, novelty, boutique) drive category fit and the 8-point fashion assortment tier. *Gifting* words (gift, gifts, gifting) support assortment only (4 points, with retail evidence); a gift word never raises category fit. This is what makes "City Gift Gallery" score 16 for category, as in 4.4.
- A criterion counts as resting on V/H evidence only when it earned points; the evidence-quality point needs four of the **other five** criteria to do so. A criterion has "any evidence" for the Insufficient Information rule when its grade is not U.
- Geography: 10 for a target city; 6 only for the state of a **target** city (an expansion city's own state does not earn it); 3 for an expansion city. "Outside every configured location" is declared only when a state is named in the address and neither it nor the city matches any configured location, target or expansion.
- Only city-level address components identify the city (locality, postal town, level 3); a district never counts as the city.
- A social-media page counts as a listed website for contactability but never as evidence of a duplicate.
- The persisted result has two modes: points, rule codes and flags, or the legal fallback of status, band and total only (R1).

### 4.3 Outcomes
The first matching rule applies. Only rows 1 and 2 are automatic conclusions; every other row only **routes to a person**.
| Order | Outcome | Rule |
|---|---|---|
| 1 | **Duplicate** | Same Place ID, or a transient-field or CRM match (phone, website domain, name+locality). Stored as a link with the rule code. A person can undo it. |
| 2 | **Rejected (hard fact only)** | Permanently closed (V), or outside every configured location (V). Nothing inferred from names or scores ever auto-rejects. |
| 3 | **Insufficient Information** | Fewer than three of the six criteria have any evidence. |
| 4 | **Needs Review** (everything else) | Sorted by priority band: **High** total ≥ 55, **Medium** 35–54, **Low** under 35. Bands are pilot placeholders. |
| 5 | **Qualified** | **Set only by a person** through acceptance (section 3, steps 9 and 10). |

**Review flags** (shown to the reviewer, never decisive): a jewellery store with a name signalling precious metal or diamonds and no fashion signal ("possible gold or diamond jeweller"); a name signalling a manufacturer or wholesaler (possible competitor or partner; **not** treated as a partner by default); repair-only wording; an online-only indication; temporarily closed; category rests on inference only.

Low-band candidates are kept in a "Low priority" bucket with a bulk-reject action for approvers. They are never discarded automatically.

### 4.4 Illustrative examples (invented businesses)
- *"Anaya Fashion Jewellery"*: jewellery-store type, operational, in a target city, 42 ratings, phone and website listed → 24 + 8 + 15 + 10 + 10 + 10 = **77, High priority, Needs Review.** A person decides; the chip reads "assortment not verified".
- *"Sharma Jewellers & Sons"* (gold wording, no fashion signal): 16 + 0 + 15 + 10 + 10 + 8 = **59, High band with the precious-metal flag.** A person decides.
- *"City Gift Gallery"*: no phone or website, no ratings → 16 + 4 + 10 + 10 + 6 + 1 = **47, Medium.**
- A listing marked permanently closed → **Rejected (hard fact).**

### 4.5 What the system never does
It never infers a stock range, price level, contact person, email address, social handle or "new business" claim from missing data, never fills a gap to reach a band, and never auto-qualifies. Bands and weights are untuned starting points to be calibrated in the pilot.

---

## 5. Google Places API integration architecture

### 5.1 API surface (unverified until a live call)
Official **Places API (New)** over HTTPS, server-side only: **Text Search (New)** `POST /v1/places:searchText` (a field mask is required; up to 20 results a page and, I believe, about 60 per query through paging) and **Place Details (New)** `GET /v1/places/{placeId}`. No other Google product, no scraping of the Google Maps site or listings.

### 5.2 Fields (a whitelist; the mapper copies named fields only)
| Stage | Requested | Purpose | Where it goes |
|---|---|---|---|
| Search | place id, display name, formatted address, address components, location, types, primary type, business status | geography, status, type and name signals | **Place ID** to the candidate row; everything else to the **transient cache** |
| Details | website, national phone number, rating, rating count, only for survivors | contactability and activity | transient cache only |
Not requested: reviews, photos, opening hours, editorial text. A field that is absent is unknown, never assumed.

### 5.3 Two-stage design (cost)
Google bills a request at the **highest-priced field tier in its mask** (unverified). Stage 1 uses the cheapest mask that supports the geography/status/type pre-filter; stage 2 runs only for non-duplicate survivors.

### 5.4 Execution model (as M5; no background infrastructure for searching)
A campaign expands into **search units**. The browser repeatedly calls `POST /api/prospecting/campaigns/:id/run`; each call runs one bounded step, persists progress, and returns `done`, `more`, `waiting` or `failed`. One active run per campaign (a partial unique index, as in M5). Page tokens are held only until the unit finishes or the token expires, then cleared.

### 5.5 Duplicate detection under strict storage
1. **Place ID**, unique per organisation, is the permanent key.
2. Phone, website domain and normalised name+locality are compared **in memory** against (a) other transient-cache rows that are still fresh and (b) the CRM retailers (using the same normalisers as the CSV import). Only the **resulting link** (`duplicate_of`, rule code) is stored. After the cache expires the Google-side keys are gone; the Place ID and the recorded decision remain, which is what prevents re-review.
3. A person can undo a fuzzy duplicate.

### 5.6 Terms, attribution and storage (D1 applied; unverified, counsel to confirm)
My understanding of the Google Maps Platform terms: Place IDs may be stored (and should be refreshed if old, I recall after about 12 months); latitude and longitude may be cached only for a limited period (I recall up to 30 days); other Places content (names, addresses, phone numbers, websites, ratings, reviews) may not be stored beyond a short permitted period; attribution is required where content is displayed; use of content for model training or for export outside Google services may be restricted. The design therefore:
- stores **only the Place ID indefinitely** (with `place_id_checked_at` so it can be refreshed through the cheapest call);
- puts every other Google field in one **transient cache table** whose **database constraint forbids an expiry later than 30 days** after fetch, with a configurable shorter default (proposed **7 days**);
- shows Google fields only while fresh, with Google attribution and a link to the business on Google Maps;
- never copies a transient field into `retailers`, `leads`, `approvals`, `agent_activity`, `tasks`, outreach, logs, exports, test fixtures or error messages (section 6.2 rules and tests);
- keeps only our own derived outputs permanently (priority points and rule codes, decisions, links).

### 5.7 Spending controls (D4 applied)
- **Billing stays off.** Environment variable `GOOGLE_PLACES_ENABLED` defaults to `false`; with it off the client refuses every call. I will not activate billing, create a project or make a paid call without your explicit approval.
- **Hard caps at three layers.** (1) Application: per-campaign request caps and an estimated-cost cap, plus an organisation monthly cap. Before **every** call the runner makes an **atomic reservation** in the database (increment-if-below-cap), so concurrent requests cannot overshoot. (2) Google Cloud: **API quota caps** set to the pilot level, which genuinely stop requests. (3) A budget **alert** at 50, 80 and 100 percent. Note that Google Cloud budgets by themselves **only alert; they do not stop spending**, which is why the quota cap matters.
- **Usage monitoring.** An append-only usage ledger (per day, operation and campaign: request counts and estimated cost) feeds the Performance tab; it holds no Google content.
- **Emergency stop.** A campaign Pause, an organisation-wide "stop all prospecting" switch (owner/admin, takes effect before the next call), and the environment switch.
- **Pilot budget.** The amount is yours to set (decision R3). A suggested shape: 2 cities, 4 categories, 1 term each = 8 units, at most 24 searches, at most 100 detail calls, which at the assumed prices is a few US dollars (section 9).

### 5.8 Google Cloud ownership checklist (D3 applied; none of this is done)
1. Cheri & Co./VEDASRI creates (or nominates) the Google Cloud organisation/project and owns the **billing account**; a developer's personal account is not used.
2. Client grants a named technical contact only the roles needed to enable the **Places API (New)** and create a key; roles are removed afterwards.
3. Only Places API (New) is enabled; the API key is **restricted to that API**. (A server host without a static address cannot rely on an IP restriction; quotas and monitoring are the compensating controls.)
4. Quotas are capped to the pilot; budget alerts set; billing contacts named.
5. The key is passed through a secure channel into the hosting provider's secrets (never chat, never git), with a rotation and revocation plan.
6. **Billing is activated only after your explicit approval**, then a capped live test (Phase 7).

### 5.9 AI and enrichment (D6 to D9 applied)
None in version one. Qualification is deterministic and needs no model or key. Website reading (FR18) and AI classification or wording (FR19) are **not built or proposed for the pilot**; each would need its own approval, and Google-sourced content must not be sent to a model while the terms question is open. A person may consult the business's own website or social page manually; that is the independent-source route.

### 5.10 Code layout (proposed, not created)
`src/lib/prospecting/` with `places/` (client, mappers, field masks), `scoring/` (rubric, normalisers, band logic), `runner/` (units, reservations), `repo` interface and a Supabase implementation scoped to one organisation, and `outreach/`. **Types keep the two data classes apart** (`GoogleTransient` is a distinct type that no CRM writer accepts). Routes under `src/app/api/prospecting/`; UI as new tabs on `/b2b`. The Places host string is allowed only under `src/lib/prospecting/places`, with a guard test like the Amazon one.

---

## 6. Database changes: reconciliation and proposal
No migration file is written and no existing table is altered. This section reconciles the proposal with the existing schema. **The detailed, validated-in-scratch SQL design (revised for the Priority 0 and 1 review findings) is in `docs/GOOGLE_MAPS_B2B_PHASE1_SCHEMA_PROPOSAL.md`; where it differs from the table list in 6.3, that document wins.** Migration A (version 2) holds ten tables (the nine below plus `prospect_purge_runs`); Migration B, later, holds `prospect_suppressions`, `prospect_outreach` and `prospect_outreach_drafts`; an optional Migration X adds one trigger on `approvals`.

### 6.1 Reconciliation with existing tables
| Existing table | Treatment |
|---|---|
| **`retailers`** | **Unaltered. It remains the permanent CRM record**, populated only from independently sourced details. It gets no Place ID column; the candidate row links to it. |
| **`leads`** | **Unaltered.** Created through the existing path at stage `new`, only on human acceptance. Score and temperature on the lead use the existing `temperatureFor`; the lead's score is **not** the Google-derived priority score unless a person decides it should be. |
| **`approvals`** | **Unaltered.** Used for outreach only (type "B2B outreach", a new `meta.kind` for prospect outreach). **Candidate acceptance is deliberately not an approval row**, because `approvals.preview` and `meta` persist and would permanently hold Google content. |
| **`audit_log`** | **Unaltered and not reused for candidates:** it requires an `approval_id` and only allows approve/reject/edit. Approval decisions keep using it through `decide_approval()`. **It is append-only by trigger** and its rows cascade only with the organisation, so it cannot be erased by the application either. |
| **`agent_activity`** | **Unaltered; written with ids and fixed action text only** (agent `b2b`, `ref_type 'prospect_candidate'`), never a Google-sourced name. It serves as the audit trail for candidate decisions, with the actor. **It is append-only by trigger, so a row can never be erased or corrected**; that is why only ids and fixed text may ever go in it (section 6.6). The existing `liveCreateRetailer` writes "Added retailer: <business name>" into it today, which is permanent. |
| **`tasks`** | Unaltered; follow-up tasks via the existing path. |
| `customers`, `products`, `orders`, `content_items` | Untouched. |

### 6.2 Separation of data classes
| | **Class G: Google-sourced, transient** | **Class P: permanent, organisation-owned** |
|---|---|---|
| Content | Business name, address, location, types, phone, website, rating, status as returned by Google; page tokens | Place ID; priority points and rule codes; status and decisions; duplicate links; configuration; campaigns and counters; **independently sourced** retailer details with provenance; outreach records; suppressions |
| Lives in | `prospect_place_cache` and unit page tokens only | Everything else, including the existing `retailers`/`leads` |
| Lifetime | Expires (default 7 days, hard maximum 30, enforced by a database check); deleted by purge | Until the organisation deletes it or its retention rule fires |
| Shown in the UI | Only while fresh, with Google attribution and a Maps link | Normally |
| Allowed to flow into class P | **No** (the rules below) | n/a |

**Firewall rules (each has a test, section 10):**
- R-a: no class G field is ever written to any table other than `prospect_place_cache`.
- R-b: outreach drafts, approval previews and `meta`, tasks, activity text, logs, errors, exports and fixtures never contain class G content.
- R-c: the acceptance form never pre-fills from class G; the acceptance service accepts only a `HumanEnteredContact` type, not a `GoogleTransient` one.
- R-d (a "taint test"): run the whole flow with a unique sentinel string as the fake Google name, phone and website; afterwards that string must be found **only** in `prospect_place_cache` (and not at all after purge).
- R-e: Google responses are never committed as fixtures; only structure-only, documentation-derived fixtures are used, and anything captured in the live test is git-ignored and deleted.

### 6.3 Proposed tables (eleven, all new, all proposals; revision 1 proposed seven)
| Table | Class | Purpose | Key constraints |
|---|---|---|---|
| `prospect_categories` | P | Configurable categories and search terms. **No signal words** (they live in versioned code). | `(org_id, lower(label))` unique |
| `prospect_locations` | P | Configurable cities (city, state, tier, `is_expansion`, optional centre and radius). | `(org_id, lower(city), lower(state))` unique |
| `prospect_settings` | P | One row per organisation: cache days (check 1 to 30), caps, `stop_all` switch, retention periods, scoring version. | `org_id` primary key |
| `prospect_campaigns` | P | Campaign definition, status, hard caps, **atomic counters** (`requests_used`, `cost_used`). | Check status; caps positive; counters never exceed caps (check) |
| `prospect_search_units` | P (+ transient token) | Term × location, progress, page token (nulled when done or expired), fixed error codes. | `(org_id, campaign_id, term, location_id)` unique; one active run per campaign |
| `prospect_candidates` | P | **`place_id`**, `place_id_checked_at`, **automatic outcome (`auto_*`) kept apart from the human decision (`review_*`)**, band, total, per-criterion **points and rule codes**, flag codes, **`duplicate_of_candidate_id` or `duplicate_of_retailer_id`**, closed-list reason code, `retailer_id` once accepted. UUID id. **No Google text columns.** | **`(org_id, place_id)` unique**; composite FKs; checks on status, band, points; status guarded by trigger |
| `prospect_place_cache` | **G** | Whitelisted Google fields, `fetched_at`, `expires_at`. | FK to candidate; **`expires_at <= fetched_at + interval '30 days'`**; one row per `(org_id, place_id)` |
| `retailer_contact_sources` | P | **Provenance** for each contact value on a retailer: field, source type, source reference, collected by and when, attestation, purpose, `review_after`. The value stays in `retailers`; this table records where it came from. | Composite FK to `retailers`; **source type may not be `google_places`** (check) |
| `prospect_outreach` | P | **Migration B.** One row per **attempt**, with the eight FR12 states, a transition table, a single-use approval bound to a draft hash, and a suppression check on every forward move. | Composite FKs to `approvals`, `retailers` and drafts; checks on state and channel; guard trigger |
| `prospect_outreach_drafts` | P | **Migration B.** Draft text, hashed by a trigger, never edited; deleted with the retailer so approvals can hold only a shell. | Composite FK to `retailers` |
| `prospect_purge_runs` | operational | **Migration A.** Append-only, content-free log of purge steps (counts, SQLSTATE). Not readable through the API. | Append-only trigger |
| `prospect_suppressions` | P | **Migration B.** Opt-outs by **keyed HMAC computed inside the database** (Vault key, versioned) of email, phone, website host or Instagram handle; reason and date. No plaintext. Place ID is not a suppression key. Enforcement scope: see FR13. | `(org_id, kind, key_version, key_hash)` unique; append-only |
| `prospect_usage` | P | Append-only ledger, one row per **reserved** request: organisation, campaign, unit, operation, **tier, estimated cost, price basis**, time. A ceiling on what we asked for, not Google's invoice. No Google content. | Insert-only through `reserve_prospect_request()`; append-only trigger |

Every table: primary key, `org_id` with composite foreign keys, **RLS** (read: member; configuration, campaigns, settings, purge: owner/admin; candidate decisions: approver+; provenance and outreach writes: writers per the rules in section 3), a **scope-immutability trigger**, and indexes for the dashboard. No service-role key is used; the application acts as the signed-in user.

### 6.4 The separate process for independently sourced information
A discovered business becomes a permanent CRM record **only** through acceptance, by an approver, owner or admin, with these inputs entered **by the person**:
1. **Business name and any address or contact values**, taken from an **independent source**, chosen from a closed list: `owner_submitted` (the owner gave it to us, for example through a Meta campaign form, an inbound message or a call they made), `own_website`, `own_social_page`, `direct_enquiry` (we asked the business directly), `referral`, `trade_show_or_card`, `trade_directory_permitted` (only a directory whose terms allow this use; **disabled by the R7 default, so it is not in the first database check list**), `existing_crm` (see the attestation path in the Phase 1 proposal, section 5). **`google_places` is not an option, and the database check refuses it.**
2. **A source reference** (a URL of the business's own page, or a dated note such as "spoke to owner on 12 Nov").
3. **An attestation** by the approver that the details did not come from Google Maps content, recorded with their identity and time.
4. **A purpose** (`b2b_outreach`) and a **review-after date**.
If no independent source exists, the candidate **cannot be accepted**; it stays "Needs more information" and its Google data expires. A candidate with no independent contact simply cannot be contacted by this system. This is the intended, conservative outcome.

**Honest limits of this control.** The system cannot technically prove a typed phone number was not first seen on Google. The controls are the closed source list, the required reference, the attestation, the audit trail, and the refusal to pre-fill. Whether a person re-typing a value they first saw on Google counts as independent is a question for counsel (R1); the rule here is that a value is storable only if an independent source for it is actually recorded.

### 6.5 Other proposed constraints
- Candidate status transitions are guarded by trigger (for example `accepted` requires a non-null `retailer_id`, a decider with approval rights, and an existing provenance row).
- Optional hardening, separately approved: a trigger on `approvals` (the M5 pattern) requiring that a prospect-outreach `meta.ref` names a retailer in the same organisation with a provenance row.

### 6.6 Retention and deletion controls (D1 applied)
| Control | Behaviour |
|---|---|
| Cache expiry | `expires_at` is set at fetch (default 7 days, maximum 30 by constraint). Reads ignore expired rows. |
| **Physical deletion of expired rows** | Needs a scheduled purge. Options: (a) a Supabase `pg_cron` job inside the database running `private.purge_expired_place_cache()` hourly; (b) lazy purge on each prospecting request plus an admin "Purge now" button. (a) is recommended because compliance should not depend on someone using the app; it is a database feature, not a new service, but it **is scheduled infrastructure, so it needs your approval (R2).** Until decided, only (b) is assumed. |
| Purge now | Owner/admin button and RPC; deletes all class G rows and page tokens for the organisation. |
| Candidate lifecycle | Unreviewed candidates older than a set period move to `expired`; only the Place ID and decision remain. Rejected Place IDs are kept so they are not re-reviewed. |
| Place ID freshness | `place_id_checked_at`; stale IDs are refreshed through the cheapest call or dropped (unverified rule, about 12 months). |
| Provenance review | `review_after` (default 12 months) lists prospect contacts with no engagement for a person to renew or delete. |
| Erasure on request (**corrected**) | **What the application can erase:** the retailer (its lead, provenance rows and outreach rows cascade), the candidate's cache row, and the candidate's links. **What it cannot erase:** (1) `agent_activity` and `audit_log` rows, which are append-only by trigger; (2) **approvals**, which have no deletion path for any role, and whose `preview` (up to 6,000 characters) and `meta` can hold a person's name, email, phone or business details; (3) tasks and notes that name the business; (4) existing code that logs the business name permanently ("Added retailer: <name>"). **Mitigation, compliant with the append-only design:** (a) from Phase 1 onward prospecting code writes only ids and fixed text to `agent_activity`, and never puts personal or business details in an approval `preview` or `meta` (only the retailer id in `meta.ref`, with the draft shown from the live retailer record, not copied); (b) existing history is not rewritten; (c) a personal-data erasure of existing history is a **manual, owner-run, counsel-approved procedure outside the application** (a documented database operation by the project owner, recorded in an external log), not a feature; (d) suppression is added **before** deletion, as a keyed hash, so the person is not contacted again. **Unresolved under R1:** whether append-only retention of business names in existing history is acceptable for business (non-personal) data, whether a sole trader's business name is personal data, and whether the manual procedure is sufficient. |
| Campaign deletion | Deleting a campaign deletes its units and any class G rows tied only to it. |
| Verification | Tests prove the expiry constraint, purge function, erasure cascade and taint rule (section 10). |

---

## 7. Dashboard changes
Extend `/b2b` with `Tabs` (`?tab=`), keeping the current content as **Leads** and following the existing design system.
| Tab | Content |
|---|---|
| Leads (existing) | Unchanged. |
| Campaigns | List and create; category and city pickers; caps; **cost estimate against remaining budget**; Run, Pause, **Stop all**; per-unit progress; spend from the usage ledger. |
| Review queue | Candidates by priority band with per-criterion points and flags; Google fields **only while fresh**, with attribution and a Maps link; "Refresh details" (shows its cost); decision actions for approvers. |
| Accept (form) | The independent-details form of section 6.4. No pre-fill from Google. |
| Rejected and duplicates | Reasons; undo for fuzzy duplicates. |
| Outreach | Drafts, approval status, contacted, interested, follow-up due, opted out. |
| Performance | Funnel, acceptance rate, reviewer workload, cost per accepted lead, usage and cap status. |
| Settings (owner/admin) | Categories and signal words, cities, bands (versioned), cache days, caps, retention, Purge now, Stop all. |
Demo organisations show SAMPLE data and a `SimBadge`. Viewers see everything read-only.

---

## 8. Security and compliance

### 8.1 How contact details can lawfully be retained for future B2B outreach
This is the design's reasoning, **not legal advice**; counsel must confirm it (R1).
1. **Google-sourced contact details are not the basis for retention.** They live in the transient cache and are deleted on schedule. Nothing in the system depends on keeping them.
2. **What is retained is independently sourced,** each value with: where it came from (a closed list that excludes Google), a reference, who recorded it and when, the purpose, and a review date. Examples that support a lawful basis: the owner submitted the details to us (a Meta campaign form, an inbound enquiry); the business published them on its own website or page for contact; we asked the business directly and it answered; a trade-show or referral introduction.
3. **Indian data protection.** A shop's number or a proprietor's name can be personal data under the Digital Personal Data Protection Act, 2023 and its rules (commencement and obligations are phased; **current status unverified**). The Act recognises processing on consent and for certain "legitimate uses", including data an individual voluntarily provides for a specified purpose. The design supports whichever basis counsel selects: purpose recorded per value, minimum fields, source evidence, a clear opt-out in the first message, a permanent suppression on opt-out, a review-after date with deletion if unengaged, and an erasure procedure.
4. **Business-to-business messaging rules** (for example Indian telecom rules on commercial communications and WhatsApp's own business policies) may apply to first contact. **Unverified.** The conservative default is one-to-one, human-written, human-sent first contact with consent and opt-out handling, all through approval. The system checks and displays; it cannot establish consent.
5. **What the system will not do:** keep a phone number whose only source is Google; treat the Maps link as a source; send anything itself.

### 8.2 Other topics
| Topic | Position |
|---|---|
| Secrets | Server-only key, placeholder name only in `.env.example`, never committed, in the browser or logs; one source guard confines the host string. |
| Tenancy | `org_id` and RLS everywhere; repo bound to one organisation; no service-role key. |
| Roles | Search and settings: owner/admin. Acceptance and rejection: owner/admin/approver. Drafting and review notes: writers. Viewer: read-only. |
| Cost abuse | Billing off by default, explicit Run, atomic caps, quota cap in Google, Stop all, no calls from demo organisations or on page load. |
| Human approval | Acceptance by a person; every outreach through Approvals; no automatic WhatsApp, email or other messaging; no unofficial WhatsApp automation. A click-to-chat link is **off** until approved (R8). |
| Claims | The existing claim guard runs on every draft; drafts state no price, term or product claim the client has not supplied. |
| Accuracy | U earns nothing; mappers whitelist; drafts use independent fields only. |

---

## 9. API cost, quota and target realism

### 9.1 Costs
**Prices are my recollection of Google's list prices; verify on the current page before budgeting (unverified).** A monthly free allowance per product tier may apply (unverified), and a billing account is required (in India this may need a verified or prepaid payment method).
| Item | Assumption (unverified) |
|---|---|
| Text Search, mid tier | about US$32 per 1,000 |
| Text Search, top tier | about US$35 per 1,000 |
| Place Details, top tier | about US$20 per 1,000 |

### 9.2 Pilot sizing (illustration, not a quote)
8 units (2 cities × 4 categories × 1 term) × at most 3 pages = at most **24 searches** (about US$0.84) plus at most **100 detail calls** (about US$2) = **about US$3**, probably inside any free allowance. Because Google data expires, **a review that runs after the cache window forces a refresh call (about US$0.02 each)**; reviewing in batches inside the window avoids doubling cost. A wider sweep (160 units, about 600 detail calls) is about US$27 a week at the same assumptions; do not scale up until the pilot has measured yield.

### 9.3 The 50 to 100 weekly target, revisited
It is a **business goal**, not something Google can guarantee, and strict storage plus mandatory human acceptance make it harder, not easier. Realistic reasoning, with every number an **assumption to be replaced by pilot measurements**:

1. **Discovery is a one-time backlog, not a weekly flow.** Each unit returns at most about 60 results (unverified). Many shops appear under several terms; assume 40 to 60 percent overlap. A pilot of 16 units gives at most about 960 results, roughly **380 to 580 unique** businesses. After removing closed, out-of-area and non-retail results, assume **30 to 50 percent** are plausible: **about 115 to 290 candidates** to review in the first sweep.
2. **Steady state is much smaller.** After the first sweep the same Place IDs come back and are skipped. New weekly candidates come only from genuinely new businesses and from **expanding** to new cities and terms. Ten Madhya Pradesh cities will saturate; sustained volume needs a continuing expansion plan, each wave with its own cost.
3. **Human review is the binding constraint.** At about **3 to 4 minutes** per candidate and, for those accepted, about **10 more minutes** to find and record an independent source, 200 candidates with a 15 to 35 percent acceptance rate is **about 10 to 15 hours of review plus 5 to 12 hours of sourcing** for roughly **30 to 70 accepted leads** over the first sweep.
4. **Planning figures.** Per week, from Places alone: during an expansion wave with one or two reviewers, **about 10 to 40 accepted leads**; between waves, **under 10**. **50 to 100 a week is not a defensible planning figure from Places discovery** under these rules.
5. **Where volume realistically comes from.** Leads from **Meta campaigns** are submitted by the business owner, so they are independent and need no Google data; they enter through the existing import/entry paths and can reach this module's outreach and tracking. The 50 to 100 target should be tracked as **total qualified B2B leads from all sources**, with Places as one supply route. This does not change the "no artificial leads" rule.
6. **The pilot defines the real numbers.** Success is measured as: candidates reviewed, acceptance rate, minutes per review, independent sources found per accepted lead, cost per accepted lead. The target is revised from those.

---

## 10. Phased implementation plan
Nothing starts without your approval. Every phase ends with the full Vitest suite, `tsc`, `eslint` and the build green, and no hosted change.

| Phase | Scope | Depends on | Tests and exit criteria |
|---|---|---|---|
| **0. Decisions and setup** | Section 11 answers; counsel's read on R1; Google Cloud ownership checklist (5.8); roadmap amendment. **No billing activation.** | You, client | Written decisions; named Google Cloud owner. |
| **1. Schema proposal** | **Proposal version 2 delivered 2026-11-16 (`docs/GOOGLE_MAPS_B2B_PHASE1_SCHEMA_PROPOSAL.md`, applying the security review decisions O1 to O25; O26 and O27 decided at closure, 2026-11-16); local migration files still await your go-ahead and the R1 clearance.** No apply. Migration A (ten tables) first; Migration B (outreach, drafts, suppressions) later; Migration X (one `approvals` trigger) only on a separate go-ahead. | 0 | PGlite: RLS role matrix; cross-organisation isolation; `(org_id, place_id)` uniqueness; **30-day expiry constraint**; provenance source check refusing `google_places`; scope immutability; status-transition triggers; usage ledger append-only; counters never exceed caps; forward-only; no change to existing tables; migration identical to the document. |
| **2. Scoring engine** | Pure rubric, bands, hard-fact rules, normalisers, versioned config. | 0 | A test per rubric cell and cap; the 77 ceiling; outcome order; **no auto-qualify and no inference-based auto-reject**; U earns 0; determinism; the 4.4 examples; mutation checks. |
| **3. Places client** | Client, field masks, whitelist mappers, throttle, reservations, redaction, kill switch. Fake transport, structure-only fixtures. | 0 | Mapper tests with missing fields; unknown fields dropped; retries and no-retries; quota handling; **no call when disabled or at cap**; no key or Google text in errors or logs; host confined by a source guard. |
| **4. Runner and persistence** | Units, resumable steps, atomic cap reservation, in-memory duplicate checks, repo, transient cache, purge function. | 1, 2, 3 | Idempotent re-runs; resume; **concurrent runs cannot exceed a cap**; expiry and purge; organisation scoping; demo organisations never call; **the taint test (6.2 R-d)**. |
| **5. Review and acceptance** | Review queue, independent-details form, acceptance service creating retailer and lead through the existing path, provenance, activity log. | 4 | Only approver+ can accept; acceptance impossible without a source and attestation; form never pre-fills from Google; Google text absent from `retailers`, `leads`, `agent_activity`; existing retailer, import and pipeline tests unchanged. |
| **6. Dashboard** | `/b2b` tabs, campaign form, progress, performance, settings, Stop all, Purge now. | 4, 5 | Component and API tests; permissions and CSRF; viewer read-only; attribution shown; demo labelling. |
| **7. Outreach and approval** | Drafts from retailer and provenance only, suppression, eight states, approvals integration, `meta.kind`, decision-time guard, tasks, erasure. | 5 | M2 to M5 approval tests unchanged; suppression blocks; draft builder cannot read class G (type and source guard); nothing is ever sent (source guard against send APIs); erasure cascade. |
| **8. Live connection test** | **Only after your explicit approval to activate billing.** A handful of capped real calls to record real shapes, tiers and costs. Real responses are git-ignored and deleted; only structure is documented. | 3, Google Cloud ready | Contract document of what Google actually returned. **The integration is not called live until this passes.** |
| **9. Pilot and UAT** | One campaign in two cities; measure the figures in 9.3; adjust bands and the target. | 8 | Signed-off yield, review time, cost per accepted lead. |
| Later | Wider expansion; any enrichment or AI (each separately approved). | 9 | n/a |
Hosted RLS verification of the new schema follows the M5 route: staging only, after M1 resumes.

---

## 11. Decisions (resolved and remaining)

### 11.1 Resolved by you, now applied
D1 strict compliance; D2 human approval before CRM; D3 company-owned Google Cloud; D4 small pilot, hard cap, monitoring, emergency stop, no billing without approval; D5 all first contact through human approval; D6 to D9 conservative defaults (no auto-qualification, no enrichment, no AI, no website reading).

### 11.2 Resolved by me as conservative defaults (change any you disagree with)
- Seed categories are the eight in the brief; signal words are a short, visible, editable list; manufacturers and wholesalers are a **Needs Review flag, not partners**.
- Priority bands High ≥ 55, Medium 35–54, Low under 35 (placeholders, calibrated in the pilot). No band changes a status.
- Cache window **7 days** (database maximum 30).
- Acceptance and rejection by owner, admin or approver. **Staff and viewers are read-only on candidates** (corrected: there is no free-text annotation in version 1, because free text could hold Google content; reasons are a closed list of codes).
- Unengaged prospect data reviewed after **12 months**.

### 11.3a Outcome (2026-11-16): revision 2 accepted, proposed defaults adopted
The owner accepted revision 2 and told me to proceed with the defaults proposed for R1 to R12. Status of each, so nothing is mistaken for done:

| # | Adopted default | Still needed from a person before it can be acted on |
|---|---|---|
| R1 | Design stands as written; treated as **provisional until counsel confirms**. | Counsel's written view. Phase 1 data design does not start before it. |
| R2 | `pg_cron` purge inside the database, recommended option. | Nothing now; it is created only by a later approved migration. |
| R3 | Smallest cap the design allows; **no figure invented**. | The pilot budget, per-campaign and monthly caps, quota level. Blocks Phase 8. |
| R4 | Cheri & Co./VEDASRI owns the Google Cloud project and billing. | Named owner and who grants technical access. Blocks Phase 8. |
| R5 | Billing stays **off**. | Separate explicit approval to activate. |
| R6 | Capacity is the volume limit; targets stay unpromised. | Named reviewers and weekly hours. |
| R7 | Closed list in 6.4 stands, with `trade_directory_permitted` **disabled** until confirmed. | Owner/counsel confirmation to enable it. |
| R8 | Click-to-chat link **off**; plain-text drafts only. | Explicit approval to ever enable it. |
| R9 | Roadmap section J amended (specification only), see that file. | None. |
| R10 | Target reframed as total qualified B2B leads from all sources; Places is one measured route. | None. |
| R11 | **Not adopted now.** Optional later, not part of the first build. | A separate approval if wanted. |
| R12 | M1 staging stays **deferred**. | A decision when it resumes. |

Adopting defaults changed no code, migration, existing table, API connection, billing state, commit, push or deployment. Section 11.3 below is the original list, kept for the record.

### 11.3 Remaining decisions requiring your approval (original list)
| # | Decision | Notes |
|---|---|---|
| **R1** | **Legal confirmation** of: the "independent source" rule and attestation mechanism; storing derived score codes; Place ID retention and refresh; the DPDP and messaging position in 8.1. | Blocks Phase 1 data design if counsel disagrees. |
| **R2** | **Scheduled purge:** approve a `pg_cron` job in the database (recommended) or accept lazy purge plus a manual button. | It is scheduled infrastructure, so it needs your explicit yes. |
| **R3** | **Pilot budget**: the amount (INR or USD), the cap per campaign, the monthly cap, and the Google quota level. | A number from you; the design only enforces it. |
| **R4** | **Google Cloud owner**: who at Cheri & Co./VEDASRI owns the project and billing, and who grants technical access (5.8). | Needed before Phase 8. |
| **R5** | **Billing activation** approval, when ready. | Not requested now; nothing paid happens before it. |
| **R6** | **Reviewers and capacity**: who reviews and accepts, and how many hours a week. | Review time is the binding constraint on volume. |
| **R7** | **Allowed independent source types** (the closed list in 6.4), especially `trade_directory_permitted`. | Controls what can be stored. |
| **R8** | **First-contact channel text options** and whether a click-to-chat link may ever be used. Default: off. | Messaging rules. |
| **R9** | **Roadmap amendment:** permission to edit section J of `FINAL_DELIVERY_ROADMAP.md` to include this module. | I have not edited it. |
| **R10** | **Reframe the target** as "total qualified B2B leads from all sources", with Places tracked as one route and measured in the pilot. | Section 9.3. |
| **R11** | Optional later: the `approvals` hardening trigger for prospect outreach (6.5). | Adds a trigger to an existing table. |
| **R12** | M1 staging (hosted RLS verification) is still deferred; confirm it stays deferred or when it resumes. | Same as M5. |

---

## 12. Verification status and what is not claimed
- **Nothing is built, connected or tested.** No Places call has been made, no Google key or project exists, no billing is active, no schema or fixture has been written.
- All Google statements (endpoints, tiers, page limits, prices, free allowances, quotas, storage periods, attribution) are **unverified** until a live capped call and a reading of the current documents.
- Indian law and messaging rules are noted, not interpreted; counsel must confirm them.
- The rubric, bands and every funnel figure in section 9.3 are **assumptions**, not measurements.
- Existing behaviour is untouched: this specification is the only file added.
