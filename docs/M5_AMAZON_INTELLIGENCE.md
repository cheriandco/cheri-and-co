# M5: Amazon Intelligence (Amazon India), local implementation

Status: **built, reviewed and tested locally. Not committed, not deployed, not verified against Amazon. A local migration file exists (`supabase/migrations/20261111000000_amazon_intelligence.sql`) and has NOT been applied anywhere.**
Read first: `docs/M5_SANDBOX_CONTRACT.md` (what is and is not verified about Amazon) and `docs/M5_SCHEMA_PROPOSAL.md` (the eight proposed tables).

## 1. What it does
For a live organisation (never the demo), an owner or admin connects the seller's own Amazon India account (private SP-API app,
seller self-authorisation, read-only). The app reads orders, listings, catalog data, FBA inventory and one seller report, stores
whitelisted fields in dedicated Amazon tables, shows them on `/amazon` (Overview, Orders, Products, Inventory, Reports, AI Insights), derives
deterministic insights, and lets a person send an insight to the **existing** Approvals queue. Approving records a decision only: no code path
changes anything on Amazon.

## 2. Frozen decisions (as instructed)
Amazon India `A21TJRUUN4KGV` (confirmed against Amazon's own marketplace-participation answer before any sync, never assumed) · SP-API Europe region ·
private app with self-authorisation · read-only · credentials only in server environment variables · native `fetch`, no new dependency · separate
Amazon tables, `orders` untouched · rules first, AI narration later (not built) · existing approval workflow · Competitors, Reviews and Pricing tabs
absent for live organisations.

## 3. Layout
| Area | Files |
|---|---|
| Client | `src/lib/amazon/{config,lwa,client,redact,parse,types}.ts`: LWA token provider with cache and shared in-flight refresh; token-bucket throttle per operation at Amazon's documented default rates; `ThrottledError` instead of long sleeps; retry with backoff for 5xx and network errors; one token refresh on 401; no retry for 400/403/404; host allow-list; presigned report downloads sent without the Amazon token and only to `*.amazonaws.com`; every error message redacted. |
| API modules | `src/lib/amazon/api/{sellers,orders,listings,catalog,inventory,reports}.ts`: each maps to a typed whitelist; orders never send `includedData`; only `GET_MERCHANT_LISTINGS_DATA` may be requested. |
| Sync | `src/lib/amazon/sync/{orders,catalog,inventory,reports,run}.ts`: bounded, resumable steps over an `AmazonRepo` interface. |
| Storage | `src/lib/amazon/{repo,supabase-repo}.ts`: one repo instance is bound to one organisation and one environment; every statement carries both (and the marketplace). Runs as the signed-in user, so RLS applies. **No service-role key.** |
| Insights | `src/lib/amazon/insights/rules.ts`: six pure rules. |
| Service and API | `src/services/amazon-live.ts`; routes under `src/app/api/amazon/` (see `docs/API.md`). New permission `amazon:sync` (owner, admin); it also gates generating insights, matching the database (insight inserts are owner/admin only). Sending an insight to Approvals stays with `agents:run`. |
| UI | `src/components/amazon-live-view.tsx`, `amazon-sync.tsx`; `src/app/(app)/amazon/page.tsx` renders the demo sample unchanged for demo organisations. |

## 4. How a sync works (no background infrastructure)
The browser calls `POST /api/amazon/sync {kind}` repeatedly. Each call runs **one bounded step** (default 3 pages) in the owner or admin's own session and
returns `done`, `more`, `waiting` (with `retryAfterMs`) or `failed`. The run row stores the cursor, so an interrupted or rate-limited sync resumes where
it stopped, from any later request. A rate limit is `waiting`, never a failure. One active run per kind is enforced by a partial unique index (proposed).
- **Orders:** window = (watermark, or 30 days on the first run) to (now minus 5 minutes), by `lastUpdatedTime`. The watermark advances only after the whole window is read. Upserts make re-reads safe.
- **Listings and catalog:** per page of up to 20 listings, one catalog call for their ASINs; merchant-listed quantity is stored as the `listing` inventory source.
- **FBA inventory:** one pass inside one request (Amazon's page token lives about 30 seconds); a truncated pass fails rather than storing a partial snapshot.
- **Report:** create, poll (15 s hint), download, reduce to aggregate counts, discard the file.
- **Amazon's default orders limit is about one request per three minutes after a burst of 20.** A large first sync can therefore take several clicks over time. Higher limits can be requested from Amazon.

## 5. Privacy
No buyer or recipient data is requested (`includedData` is never sent) or stored (no such columns exist, proven in PGlite and by a source guard). Mappers copy only named fields, so fields Amazon adds later cannot leak. Report files are not stored. Secrets are never logged, never serialised (`credentials()` is non-enumerable), never in client components, and scrubbed from errors.

## 6. Environments
`AMAZON_SP_ENVIRONMENT` (server configuration; default `sandbox`; production only when set explicitly) selects the host and the `environment` stored with every row. Reads and writes are scoped to it, so sandbox and production data never mix, and a request cannot choose it. The page labels sandbox data **SIMULATED**. **Sandbox insights cannot be sent to Approvals.**

## 7. Insights (deterministic, provisional thresholds)
Top sellers · sales trend (30 vs previous 30 days, minimum 10 prior units, change of 20% or more) · low inventory (FBA days of cover under 14, "act" under 7) · inventory risk (unfulfillable plus researching at least 5 units or 10%) · listing issues (errors "act", warnings "watch") · unusual change (7-day daily rate against the prior 28 days, 2x or 0.4x, minimum 20 units). Every insight carries evidence (metric, value, source, period); the proposed table also forbids an empty evidence array. The dedupe key includes the ISO week, so regenerating in a week adds nothing and never resets a submitted insight. **Thresholds are starting points, not tuned to this client**: review them with real sales. "Ordered value" is units times listed price, not revenue.

## 8. Approval integration
Queued as type "Amazon insight", `generated_by 'amazon'`, meta `{kind: 'amazon_insight', agent, ref: insightId, environment, ...}`; the preview ends with "Approving records a decision only. Nothing is changed on Amazon." Duplicate refusal by pending meta ref and by insight status. The claim guard runs at queue time and, via an additive change to `liveDecideApproval`, at decision time. Existing M2, M3 and M4 behaviour is unchanged (their tests pass unmodified; one content-agent source guard was narrowed, see section 11).

## 9. What is verified and what is not
Verified by tests: client behaviour, mappers, sync modules (pagination, resume, idempotency, throttling, failure), organisation and environment scoping in application logic, permissions and CSRF, demo refusal, the approval flow, source guards, and the proposed SQL in PGlite. Mutation checks confirmed the key tests fail when the protection is removed.

**Not verified:** anything against real Amazon (no credentials exist). Specifically unconfirmed: the marketplace id and country pairing for this account, that SigV4 is not required, which roles each operation needs, which sandbox requests have canned answers, and the real response shapes. Fixtures in `tests/fixtures/amazon/*.json` are **documentation-derived**. Only files in `tests/fixtures/amazon/captured/` would be actual sandbox responses, and none exist. The RLS policies and `decide_approval` have not been run on a hosted database (M1 deferred). The fake-client tests prove application logic, not RLS.

## 10. To go live (all need your approval or input)
1. Approve the schema (the migration file exists locally and is not applied). Apply to a staging project first.
2. Create the private SP-API app and self-authorise it; supply credentials through server environment variables (`.env.example` lists them), never in chat.
3. Run `AMAZON_LIVE_CHECK=1 npx vitest run tests/amazon-sandbox.live.test.ts` against the sandbox; record findings in `docs/M5_SANDBOX_CONTRACT.md`.
4. Review insight thresholds with real data. Decide whether to request higher orders rate limits.
5. Production is a separate, explicit configuration change after the above.

## 11. Changes to existing files
Additive: `roles.ts` (`amazon:sync`), `types/index.ts` (union members), `live.ts` (decision-time claim scan includes `amazon_insight`), settings page row, `.env.example`, `.gitignore`, docs. Page: a live branch was added and the demo branch is untouched. `tests/content-agent.test.ts`: the guard that banned the string `sellingpartnerapi` anywhere in `src` now allows it only under `src/lib/amazon`; the other banned hosts are unchanged. `tests/m3-api.test.ts` is unchanged: the old per-row `queueAgentAction("amazon")` still answers "not connected" for live organisations (the dashboard uses the new route).
