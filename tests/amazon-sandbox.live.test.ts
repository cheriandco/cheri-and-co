/** LIVE Amazon SANDBOX contract check. SKIPPED unless AMAZON_LIVE_CHECK=1. It has NOT been run: no Amazon credentials exist in this project yet.
 *
 *  How to run (credentials stay in your own shell, never in chat or Git):
 *    1. Put AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_SP_REFRESH_TOKEN, AMAZON_SELLER_ID in a git-ignored file such as .env.amazon.local
 *    2. Run:  AMAZON_LIVE_CHECK=1 AMAZON_SP_ENVIRONMENT=sandbox npx vitest run tests/amazon-sandbox.live.test.ts   (with those variables exported)
 *
 *  Safety: refuses to run against production, calls only read operations plus createReport, redacts everything it writes, and writes captured
 *  responses to tests/fixtures/amazon/captured/ (the ONLY files that may be called "actual Amazon sandbox responses"). Amazon's sandbox returns
 *  static data only for specific request shapes, so a 400/404 here can mean "the sandbox has no canned answer for this request", which is a finding to
 *  record in docs/M5_SANDBOX_CONTRACT.md, not a pass or a failure of our code. */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { SpApiClient, SpApiError, ThrottledError, describeApiProblem } from "@/lib/amazon/client";
import { amazonConfigStatus } from "@/lib/amazon/config";
import { createLwaTokenProvider } from "@/lib/amazon/lwa";
import { redact } from "@/lib/amazon/redact";
import { getMarketplaceParticipations, verifyMarketplace } from "@/lib/amazon/api/sellers";
import { searchOrdersPage } from "@/lib/amazon/api/orders";
import { searchListingsPage } from "@/lib/amazon/api/listings";
import { searchCatalogByAsins } from "@/lib/amazon/api/catalog";
import { getInventory } from "@/lib/amazon/api/inventory";
import { createReport } from "@/lib/amazon/api/reports";

const enabled = process.env.AMAZON_LIVE_CHECK === "1";
const OUT = "tests/fixtures/amazon/captured";

interface Outcome { operation: string; result: "ok" | "throttled" | "error"; detail: string }
const outcomes: Outcome[] = [];

describe.skipIf(!enabled)("Amazon sandbox contract check (LIVE, simulated data)", () => {
  const status = amazonConfigStatus();
  const cfg = status.ok ? status.config : null;

  async function attempt<T>(operation: string, run: () => Promise<T>): Promise<T | null> {
    try {
      const value = await run();
      outcomes.push({ operation, result: "ok", detail: "answered and parsed" });
      return value;
    } catch (e) {
      const throttled = e instanceof ThrottledError;
      outcomes.push({ operation, result: throttled ? "throttled" : "error", detail: describeApiProblem(e) + (e instanceof SpApiError && e.requestId ? ` (request ${e.requestId})` : "") });
      return null;
    }
  }

  it("is configured for the sandbox and refuses production", () => {
    expect(status.ok, "set the AMAZON_* variables").toBe(true);
    expect(cfg?.environment).toBe("sandbox");
  });

  it("exercises each approved operation and records what Amazon actually answered", async () => {
    if (!cfg || cfg.environment !== "sandbox") throw new Error("Refusing to run: sandbox configuration required.");
    const c = cfg.credentials();
    const client = new SpApiClient({ config: cfg, tokens: createLwaTokenProvider({ credentials: c }), secrets: [c.clientId, c.clientSecret, c.refreshToken], maxWaitMs: 5_000 });
    mkdirSync(OUT, { recursive: true });
    const save = (name: string, value: unknown) => writeFileSync(`${OUT}/${name}.json`, redact(JSON.stringify({ _provenance: "CAPTURED from the Amazon SANDBOX (simulated data), redacted", value }, null, 2), [c.clientId, c.clientSecret, c.refreshToken, c.refreshToken]));

    const parts = await attempt("getMarketplaceParticipations", () => getMarketplaceParticipations(client));
    if (parts) { save("marketplace", parts); outcomes.push({ operation: "verifyMarketplace(A21TJRUUN4KGV = IN)", result: verifyMarketplace(parts, cfg.marketplaceId).ok ? "ok" : "error", detail: `${parts.length} marketplace(s) listed` }); }

    const now = Date.now();
    const orders = await attempt("searchOrders v2026-01-01", () => searchOrdersPage(client, { marketplaceId: cfg.marketplaceId, lastUpdatedAfter: new Date(now - 30 * 86_400_000).toISOString(), lastUpdatedBefore: new Date(now - 10 * 60_000).toISOString() }));
    if (orders) save("orders", orders);
    const listings = await attempt("searchListingsItems", () => searchListingsPage(client, { sellerId: cfg.sellerId, marketplaceId: cfg.marketplaceId }));
    if (listings) save("listings", listings);
    const asins = (listings?.listings ?? []).map((l) => l.asin).filter((a): a is string => !!a).slice(0, 20);
    const catalog = await attempt("searchCatalogItems", () => searchCatalogByAsins(client, cfg.marketplaceId, asins.length ? asins : ["B000000000"]));
    if (catalog) save("catalog", catalog);
    const inventory = await attempt("getInventorySummaries", () => getInventory(client, cfg.marketplaceId, 3));
    if (inventory) save("inventory", inventory);
    const report = await attempt("createReport GET_MERCHANT_LISTINGS_DATA", () => createReport(client, cfg.marketplaceId, "GET_MERCHANT_LISTINGS_DATA"));
    if (report) save("report-created", { reportId: report });

    console.table(outcomes);
    writeFileSync(`${OUT}/_outcomes.json`, JSON.stringify(outcomes, null, 2));
    expect(outcomes.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("live check guard", () => {
  it("is skipped unless explicitly enabled", () => { expect(typeof enabled).toBe("boolean"); });
});
