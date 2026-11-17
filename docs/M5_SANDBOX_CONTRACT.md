# M5.0: SP-API contract verification (Amazon India)

Status: **documentation-verified only. The live sandbox check has NOT been run.** No Amazon credentials (LWA client id/secret, refresh
token, seller id) exist in any env file on this machine, so no request has been sent to Amazon. Nothing below may be described as
"tested against the sandbox". The check is written and waiting (`tests/amazon-sandbox.live.test.ts`, section 5).

Sources: Amazon's published SP-API models (`amzn/selling-partner-api-models` on GitHub) and developer documentation, read on 2026-11-11.
Where a page was truncated or unreadable, the item is listed as **UNVERIFIED** rather than guessed.

## 1. Frozen configuration

| Item | Value | Status |
|---|---|---|
| Marketplace | Amazon India, id `A21TJRUUN4KGV` | **Id not confirmed by any page I could read.** The client therefore verifies it at connection time: `getMarketplaceParticipations` must list that id with `countryCode` `IN` and `isParticipating: true`, otherwise the connection is marked failed. |
| Region | Europe (Amazon's docs state Amazon India stores use the Europe endpoint) | Verified |
| Production host | `https://sellingpartnerapi-eu.amazon.com` | Verified |
| Sandbox host | `https://sandbox.sellingpartnerapi-eu.amazon.com` | Verified |
| Token endpoint | `POST https://api.amazon.com/auth/o2/token`, `grant_type=refresh_token`, access token about 3600 s | Verified |
| Request signing | The client sends only the LWA access token in `x-amz-access-token` (no AWS SigV4). | **UNVERIFIED** in this session: the pages I read did not say. The live check will show a 403 if signing were still required. |
| Authorization | Private app, seller self-authorization in Seller Central (Apps and Services > Develop Apps), done by the account's Primary User. Each authorization produces a new refresh token. | Verified |

## 2. Operations used (all read-only `GET`, plus `POST createReport`)

| Module | Operation | Path | Limits and notes | Rate / burst (default) |
|---|---|---|---|---|
| Connection | `getMarketplaceParticipations` (Sellers v1) | `/sellers/v1/marketplaceParticipations` | Returns marketplace id, name, `countryCode`, currency, domain, `isParticipating`, `hasSuspendedListings`, `storeName`. | 0.016 / 15 |
| Orders | `searchOrders` (**Orders v2026-01-01**) | `/orders/2026-01-01/orders` | Exactly one of `createdAfter` / `lastUpdatedAfter`. `…Before` must be at least 2 minutes in the past. `maxResultsPerPage` 1 to 100. `paginationToken` expires after 24 hours. `includedData` is optional; **this app never sends `BUYER` or `RECIPIENT`** (it sends no `includedData` at all). Data older than 2 years is not returned for India. | **0.0056 / 20** (about one request every 3 minutes once the burst is spent) |
| Listings | `searchListingsItems` (Listings Items 2021-08-01) | `/listings/2021-08-01/items/{sellerId}` | `marketplaceIds` required. `includedData` `summaries,issues,fulfillmentAvailability`. `pageSize` max 20, `pageToken`. | 5 / 5 |
| Catalog | `searchCatalogItems` (Catalog Items 2022-04-01) | `/catalog/2022-04-01/items` | `identifiers` up to 20 with `identifiersType=ASIN`, one `marketplaceIds` value, `includedData` `summaries,salesRanks,images`. | 2 / 2 |
| Inventory | `getInventorySummaries` (FBA Inventory v1) | `/fba/inventory/v1/summaries` | `granularityType=Marketplace`, `granularityId`, one `marketplaceIds`, `details=true`. **`nextToken` expires 30 seconds after creation**, so a page run cannot be paused and resumed later. | 2 / 2 |
| Reports | `createReport` | `POST /reports/2021-06-30/reports` | Body `reportType`, `marketplaceIds`, optional `dataStartTime`/`dataEndTime`. Returns `reportId`. | 0.0167 / 15 |
| Reports | `getReport` | `/reports/2021-06-30/reports/{reportId}` | `processingStatus`: `IN_QUEUE`, `IN_PROGRESS`, `DONE`, `CANCELLED`, `FATAL`. | 2 / 15 |
| Reports | `getReportDocument` | `/reports/2021-06-30/documents/{id}` | Returns a presigned `url` valid 5 minutes and `compressionAlgorithm` (`GZIP` only). The download is a plain request to that URL **without** the Amazon token. | 0.0167 / 15 |

The listings report type used is `GET_MERCHANT_LISTINGS_DATA`. The client reads its columns by header name, so a column Amazon adds or
reorders does not break parsing.

## 3. Roles (non-restricted only)

Verified from Amazon's roles table: `searchOrders` accepts any one of Amazon Fulfillment, Buyer Communication, Buyer Solicitation,
Finance and Accounting, Inventory and Order Tracking, Pricing, Product Listing, Selling Partner Insights (plus four restricted roles that this app
never asks for). `getInventorySummaries` accepts "Amazon Fulfillment" or "Product Listing". Catalog Items: "Product Listing".
`GET_MERCHANT_LISTINGS_DATA` is listed under "Inventory and Order Tracking". `getMarketplaceParticipations` is listed under "Selling Partner Insights".

**Role set to request on the private app:** Inventory and Order Tracking, Product Listing, Amazon Fulfillment (only if the shop uses FBA),
Selling Partner Insights. **UNVERIFIED:** the role for `searchListingsItems` (expected Product Listing, not confirmed), and whether a non-restricted role
alone is enough to read orders when no PII is requested (Amazon's page links to a separate "Access Orders PII" guide I did not read).
A missing role answers 403; the client reports it as "Amazon refused this request (check the app's roles)".

## 4. Sandbox behaviour (verified)

- The sandbox is static for Orders v2026-01-01 and answers only requests that match Amazon's documented example requests. Real
  sandbox data is Amazon's test data, **not the client's shop**. Whether Listings, Catalog, Inventory and Reports have sandbox
  responses is **UNVERIFIED**; the live check records which ones answer.
- Hosted sandbox limit: 5 requests per second, burst 15.
- Whether the sandbox demands a real LWA token is not stated; the client always sends one.
- Therefore **every row written from a sandbox run is tagged `environment = 'sandbox'`, and the dashboard shows a permanent
  "SIMULATED: Amazon sandbox test data" banner**. Sandbox rows are never shown in production and never sent to Approvals.

## 5. Fixtures and the live check

- `tests/fixtures/amazon/*.json` are **documentation-derived**: written to match Amazon's published response schemas and examples,
  each carrying a `_provenance` field saying so. They prove the mapping code against the documented shape. They are not captured
  responses and do not prove Amazon returns this shape for this seller.
- `tests/amazon-sandbox.live.test.ts` is skipped unless `AMAZON_LIVE_CHECK=1` and the credentials are set. When run it makes one real
  call per operation against the **sandbox host only** (it refuses to run against production), redacts every token, writes what
  it captured to `tests/fixtures/amazon/captured/` (git-ignored until you review it), and prints a per-operation ok / throttled / error table
  (an error can mean the sandbox has no canned answer for that request shape; that is recorded as a finding, not a pass). Run it with the variables from `.env.example` in `.env.amazon.local` (matched by the existing `.env*.local` ignore rule).

## 6. Unresolved until the live check

1. Marketplace id confirmation (`A21TJRUUN4KGV` against `IN` / `www.amazon.in`).
2. No-SigV4 acceptance.
3. Roles for listings and for orders without PII.
4. Which operations have sandbox responses, and the real response shapes.
5. The exact meaning of an order item's `unitPrice` (whether it excludes tax and shipping). Until confirmed, the dashboard labels the
   figure "ordered item value as reported by Amazon" and does not call it revenue.
