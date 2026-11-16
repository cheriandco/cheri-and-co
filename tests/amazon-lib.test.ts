// Mappers, LWA, configuration and the Supabase repository (recording fake). Fixtures are DOCUMENTATION-DERIVED, not Amazon sandbox responses.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mapListing } from "@/lib/amazon/api/listings";
import { mapCatalogItem, searchCatalogByAsins } from "@/lib/amazon/api/catalog";
import { mapInventoryItem } from "@/lib/amazon/api/inventory";
import { mapReport } from "@/lib/amazon/api/reports";
import { amazonConfigStatus, assertAllowedBaseUrl, INDIA_MARKETPLACE_ID } from "@/lib/amazon/config";
import { createLwaTokenProvider, LwaError } from "@/lib/amazon/lwa";
import { SupabaseAmazonRepo, AmazonStoreError } from "@/lib/amazon/supabase-repo";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeAmazon } from "./helpers/amazon-fake-api";

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/amazon/${n}.json`, "utf8"));
const MP = "A21TJRUUN4KGV";

describe("mappers", () => {
  it("listings: whitelists fields, counts issues, merchant quantity only, https images only", () => {
    const [a, b] = fx("listings").items;
    expect(mapListing(a, MP)).toMatchObject({ sellerSku: "SKU-1", asin: "B000TEST01", price: 499, currencyCode: "INR", listedQuantity: 5, errorCount: 0, imageUrl: "https://example.com/a.jpg" });
    expect(mapListing(b, MP)).toMatchObject({ errorCount: 1, warningCount: 1, price: null, listedQuantity: null });
    expect(mapListing({ sku: "X", summaries: [{ marketplaceId: MP, mainImage: { link: "http://insecure/x.jpg" } }], secretField: "nope" }, MP)?.imageUrl).toBeNull();
    expect(JSON.stringify(mapListing({ ...a, internalNote: "do not store" }, MP))).not.toContain("do not store");
    expect(mapListing({ summaries: [] }, MP)).toBeNull();
  });
  it("listings: FBA-held quantity is not counted as merchant quantity", () => {
    const l = mapListing({ sku: "S", fulfillmentAvailability: [{ fulfillmentChannelCode: "AMAZON_IN", quantity: 40 }, { fulfillmentChannelCode: "DEFAULT", quantity: 3 }] }, MP);
    expect(l?.listedQuantity).toBe(3);
  });
  it("catalog: brand, main image and ranks; refuses more than 20 ASINs; empty input makes no call", async () => {
    expect(mapCatalogItem(fx("catalog").items[0], MP)).toMatchObject({ asin: "B000TEST01", brand: "Cheri", salesRank: [{ title: "Rings", rank: 120 }], imageUrl: "https://m.media-amazon.com/x.jpg" });
    expect(mapCatalogItem({ summaries: [] }, MP)).toBeNull();
    const api = fakeAmazon();
    expect(await searchCatalogByAsins(api.client, MP, [])).toEqual([]);
    expect(api.calls).toHaveLength(0);
    await expect(searchCatalogByAsins(api.client, MP, Array.from({ length: 21 }, (_, i) => `B${i}`))).rejects.toThrow(/at most 20/);
    await searchCatalogByAsins(api.client, MP, ["B000TEST01", "B000TEST01"]);
    expect(decodeURIComponent(api.calls[0].url)).toContain("identifiers=B000TEST01&");
  });
  it("inventory: maps nested quantities, rejects negatives and rows without a SKU", () => {
    const [a, b, c] = fx("inventory").payload.inventorySummaries;
    expect(mapInventoryItem(a)).toMatchObject({ sellerSku: "SKU-1", fulfillable: 4, inboundShipped: 3, reserved: 1, unfulfillable: 4, totalQuantity: 12 });
    expect(mapInventoryItem(b)).toMatchObject({ fulfillable: 50, reserved: null });
    expect(mapInventoryItem(c)).toBeNull();
    expect(mapInventoryItem({ sellerSku: "N", totalQuantity: -5 })?.totalQuantity).toBeNull();
  });
  it("reports: maps status and document id, drops unreadable entries", () => {
    expect(mapReport({ reportId: "R1", reportType: "GET_MERCHANT_LISTINGS_DATA", processingStatus: "DONE", reportDocumentId: "D1", dataStartTime: "2026-11-01T00:00:00Z" })).toMatchObject({ status: "DONE", reportDocumentId: "D1" });
    expect(mapReport({ processingStatus: "DONE" })).toBeNull();
  });
});

describe("configuration", () => {
  const ok = { AMAZON_LWA_CLIENT_ID: "id", AMAZON_LWA_CLIENT_SECRET: "secret", AMAZON_SP_REFRESH_TOKEN: "Atzr|r", AMAZON_SELLER_ID: "A1TESTSELLER" };
  it("defaults to sandbox, Amazon India and Europe, and hides secrets from serialisation", () => {
    const s = amazonConfigStatus(ok);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.config).toMatchObject({ environment: "sandbox", marketplaceId: INDIA_MARKETPLACE_ID, region: "eu", baseUrl: "https://sandbox.sellingpartnerapi-eu.amazon.com" });
    expect(JSON.stringify(s.config)).not.toMatch(/secret|Atzr/);
    expect(s.config.credentials().clientSecret).toBe("secret");
  });
  it("production is explicit, never inferred", () => {
    const s = amazonConfigStatus({ ...ok, AMAZON_SP_ENVIRONMENT: "production" });
    expect(s.ok && s.config.baseUrl).toBe("https://sellingpartnerapi-eu.amazon.com");
    expect(amazonConfigStatus({ ...ok, AMAZON_SP_ENVIRONMENT: "prod" }).ok).toBe(false);
  });
  it("names missing variables but not their values", () => {
    const s = amazonConfigStatus({ AMAZON_LWA_CLIENT_ID: "id" });
    expect(s).toMatchObject({ ok: false });
    expect(JSON.stringify(s)).not.toContain('"id"');
  });
  it("refuses any host that is not an Amazon SP-API endpoint", () => {
    expect(() => assertAllowedBaseUrl("https://sellingpartnerapi-na.amazon.com")).toThrow();
    expect(() => assertAllowedBaseUrl("https://sandbox.sellingpartnerapi-eu.amazon.com")).not.toThrow();
  });
});

describe("LWA token provider", () => {
  const credentials = { clientId: "cid", clientSecret: "csecret", refreshToken: "Atzr|rtoken" };
  const tokenResponse = (n: number) => new Response(JSON.stringify({ access_token: `Atza|a${n}`, expires_in: 3600, token_type: "bearer" }));
  it("caches, refreshes after expiry, and shares one in-flight exchange", async () => {
    let n = 0, t = 0;
    const fetchImpl = (async () => tokenResponse(++n)) as unknown as typeof fetch;
    const p = createLwaTokenProvider({ credentials, fetchImpl, now: () => t });
    const [a, b] = await Promise.all([p.getAccessToken(), p.getAccessToken()]);
    expect(a).toBe(b);
    expect(n).toBe(1);
    expect(await p.getAccessToken()).toBe(a);
    t = 3_600_000;
    expect(await p.getAccessToken()).not.toBe(a);
    p.invalidate();
    await p.getAccessToken();
    expect(n).toBe(3);
  });
  it("sends the grant to the LWA host only and never leaks secrets in errors", async () => {
    let seen = "";
    const bad = (async (url: string, init: RequestInit) => { seen = `${url} ${String(init.body)}`; return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Atzr|rtoken csecret" }), { status: 400 }); }) as unknown as typeof fetch;
    const err = await createLwaTokenProvider({ credentials, fetchImpl: bad }).getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(LwaError);
    expect(seen).toContain("https://api.amazon.com/auth/o2/token");
    expect(String(err.message)).not.toMatch(/Atzr|csecret|cid/);
    const down = (async () => { throw new Error("socket Atzr|rtoken"); }) as unknown as typeof fetch;
    const e2 = await createLwaTokenProvider({ credentials, fetchImpl: down }).getAccessToken().catch((e) => e);
    expect(String(e2.message)).not.toContain("Atzr");
  });
});

/* ---------- Supabase repository: every statement carries org + environment ---------- */
interface Call { table: string; op: string; eq: Record<string, unknown>; payload?: unknown; opts?: Record<string, unknown> }
function fakeDb(handler: (c: Call) => { data?: unknown; error?: { code?: string; message: string } | null } = () => ({ data: [] })) {
  const calls: Call[] = [];
  const db = {
    from: (table: string) => {
      const call: Call = { table, op: "select", eq: {} };
      calls.push(call);
      const q: Record<string, unknown> = {
        select: () => q, insert: (p: unknown) => { call.op = "insert"; call.payload = p; return q; }, update: (p: unknown) => { call.op = "update"; call.payload = p; return q; },
        upsert: (p: unknown, o: Record<string, unknown>) => { call.op = "upsert"; call.payload = p; call.opts = o; return q; },
        eq: (k: string, v: unknown) => { call.eq[k] = v; return q; }, in: (k: string, v: unknown) => { call.eq[`in:${k}`] = v; return q; },
        gte: () => q, order: () => q, limit: () => q, range: () => q, single: () => q, maybeSingle: () => q,
        then: (resolve: (v: unknown) => void) => { const r = handler(call); resolve({ data: r.data ?? null, error: r.error ?? null }); },
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe("SupabaseAmazonRepo", () => {
  const repoWith = (env: "sandbox" | "production" = "sandbox", handler?: Parameters<typeof fakeDb>[0]) => { const f = fakeDb(handler); return { ...f, repo: new SupabaseAmazonRepo(f.db, "org-1", env, MP) }; };

  it("scopes every read by org, environment and marketplace", async () => {
    const { repo, calls } = repoWith("production");
    await repo.getConnection(); await repo.activeRun("orders"); await repo.recentRuns(5); await repo.orders(10); await repo.products(); await repo.inventory(); await repo.salesLines("2026-01-01T00:00:00Z");
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const c of calls) { expect(c.eq.org_id, c.table).toBe("org-1"); expect(c.eq.environment, c.table).toBe("production"); expect(c.eq.marketplace_id, c.table).toBe(MP); }
  });
  it("scopes reports and insights by org and environment, and updates by id inside that scope", async () => {
    const { repo, calls } = repoWith("sandbox");
    await repo.reports(5); await repo.insights(); await repo.getInsight("i1"); await repo.markInsightSubmitted("i1", "a1"); await repo.updateRun("r1", { status: "failed" });
    for (const c of calls) { expect(c.eq.org_id, c.table).toBe("org-1"); expect(c.eq.environment, c.table).toBe("sandbox"); }
    expect(calls.find((c) => c.op === "update" && c.table === "amazon_insights")?.eq.id).toBe("i1");
    expect(calls.find((c) => c.op === "update" && c.table === "amazon_sync_runs")?.eq).toMatchObject({ id: "r1", marketplace_id: MP });
  });
  it("stamps org, environment and marketplace on every written row and uses scoped conflict targets", async () => {
    const { repo, calls } = repoWith("sandbox");
    const orders = [{ amazonOrderId: "O1", marketplaceId: MP, createdTime: "2026-11-01T00:00:00Z", lastUpdatedTime: "2026-11-01T00:00:00Z", fulfillmentStatus: "SHIPPED", fulfilledBy: null, salesChannel: null,
      items: [{ orderItemId: "1", asin: "B", sellerSku: "S", title: "T", quantity: 1, unitPrice: 10, currencyCode: "INR" }], itemCount: 1, unitCount: 1, orderedValue: 10, currencyCode: "INR" }] as never;
    await repo.upsertOrders(orders, "run-1");
    await repo.upsertInventory([{ sellerSku: "S", asin: null, fnSku: null, productName: null, fulfillable: 1, inboundWorking: null, inboundShipped: null, inboundReceiving: null, reserved: null, unfulfillable: null, researching: null, totalQuantity: 1, sourceUpdatedAt: null }], "fba");
    await repo.upsertListings([{ sellerSku: "S", asin: null, title: null, productType: null, status: [], issues: [], errorCount: 0, warningCount: 0, imageUrl: null, createdAt: null, updatedAt: null, price: null, currencyCode: null, listedQuantity: null }], []);
    await repo.upsertConnection({ status: "verified" });
    await repo.saveInsights([{ kind: "top_seller", severity: "info", title: "t", summary: "s", recommendation: "r", evidence: [{}], dedupeKey: "k", periodStart: null, periodEnd: null }]);
    const upserts = calls.filter((c) => c.op === "upsert");
    expect(upserts.map((c) => c.table).sort()).toEqual(["amazon_connections", "amazon_insights", "amazon_inventory", "amazon_order_items", "amazon_orders", "amazon_products"]);
    for (const u of upserts) {
      for (const row of [u.payload].flat() as Record<string, unknown>[]) expect(row, u.table).toMatchObject({ org_id: "org-1", environment: "sandbox", marketplace_id: MP });
      expect(String(u.opts?.onConflict), u.table).toMatch(/^org_id,environment,/);
    }
    expect(upserts.find((c) => c.table === "amazon_insights")?.opts).toMatchObject({ ignoreDuplicates: true });
  });
  it("writes no buyer or recipient column", async () => {
    const { repo, calls } = repoWith();
    await repo.upsertOrders([{ amazonOrderId: "O1", marketplaceId: MP, createdTime: "2026-11-01T00:00:00Z", lastUpdatedTime: "2026-11-01T00:00:00Z", fulfillmentStatus: "S", fulfilledBy: null, salesChannel: null,
      items: [{ orderItemId: "1", asin: null, sellerSku: null, title: null, quantity: 1, unitPrice: null, currencyCode: null }], itemCount: 1, unitCount: 1, orderedValue: null, currencyCode: null, buyer: { email: "x@y.z" }, recipient: { name: "N" } } as never], "r");
    expect(JSON.stringify(calls.map((c) => c.payload))).not.toMatch(/buyer|recipient|x@y\.z/i);
  });
  it("joins the existing active run when a parallel request wins the one-active-run constraint", async () => {
    const row = { id: "run-9", kind: "orders", status: "running", cursor: { nextToken: "T" }, counts: {}, started_at: "2026-11-11T00:00:00Z", updated_at: "2026-11-11T00:00:00Z" };
    const { repo } = repoWith("sandbox", (c) => (c.op === "insert" ? { error: { code: "23505", message: "duplicate key value" } } : { data: row }));
    expect(await repo.createRun("orders")).toMatchObject({ id: "run-9", status: "running", cursor: { nextToken: "T" } });
  });
  it("reports a missing table plainly and other failures generically", async () => {
    const missing = repoWith("sandbox", () => ({ error: { code: "42P01", message: 'relation "public.amazon_orders" does not exist' } }));
    await expect(missing.repo.orders(5)).rejects.toMatchObject({ name: "AmazonStoreError", message: expect.stringMatching(/not installed/) });
    const other = repoWith("sandbox", () => ({ error: { code: "XX000", message: "internal detail with secrets" } }));
    const e = await other.repo.orders(5).catch((x) => x);
    expect(e).toBeInstanceOf(AmazonStoreError);
    expect(e.message).not.toContain("secrets");
  });
});
