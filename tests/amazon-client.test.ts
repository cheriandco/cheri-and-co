import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { SpApiClient, SpApiError, ThrottledError, buildUrl, downloadPresigned } from "@/lib/amazon/client";
import { mapOrder, searchOrdersPage } from "@/lib/amazon/api/orders";
import { summarizeListingsReport, createReport } from "@/lib/amazon/api/reports";
import { verifyMarketplace } from "@/lib/amazon/api/sellers";
import { redact } from "@/lib/amazon/redact";
import type { AmazonPublicConfig } from "@/lib/amazon/config";

const orders = JSON.parse(readFileSync("tests/fixtures/amazon/orders.json", "utf8"));
const tsv = readFileSync("tests/fixtures/amazon/listings-report.tsv", "utf8");
const cfg = { baseUrl: "https://sandbox.sellingpartnerapi-eu.amazon.com", marketplaceId: "A21TJRUUN4KGV", environment: "sandbox" } as unknown as AmazonPublicConfig;
const tokens = { getAccessToken: async () => "Atza|SECRET-TOKEN", invalidate: () => {} };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const mk = (fetchImpl: typeof fetch, extra = {}) => new SpApiClient({ config: cfg, tokens, fetchImpl, sleep: async () => {}, random: () => 0, ...extra });

describe("SP-API client", () => {
  it("builds urls with comma-joined arrays and no empty params", () => {
    expect(buildUrl("https://x", "/p", { a: ["1", "2"], b: undefined, c: "" })).toBe("https://x/p?a=1%2C2");
  });
  it("rejects a non-Amazon base url", () => {
    expect(() => new SpApiClient({ config: { ...cfg, baseUrl: "https://evil.example" } as AmazonPublicConfig, tokens })).toThrow();
  });
  it("retries 5xx then succeeds", async () => {
    let n = 0;
    const c = mk((async () => (++n < 3 ? json({}, 503) : json({ ok: 1 }))) as typeof fetch);
    expect((await c.request("getReport", { path: "/x" })).data).toEqual({ ok: 1 });
    expect(n).toBe(3);
  });
  it("never retries 403 and redacts secrets in the message", async () => {
    let n = 0;
    const c = mk((async () => { n++; return json({ errors: [{ code: "Forbidden", message: "bad Atza|SECRET-TOKEN" }] }, 403); }) as typeof fetch);
    const e = await c.request("getReport", { path: "/x" }).catch((x) => x);
    expect(e).toBeInstanceOf(SpApiError);
    expect(n).toBe(1);
    expect(String(e.message)).not.toContain("SECRET-TOKEN");
  });
  it("throws ThrottledError when the wait is long (orders burst spent)", async () => {
    const t = 0;
    const c = mk((async () => json({ orders: [] })) as typeof fetch, { now: () => t });
    for (let i = 0; i < 20; i++) await c.request("searchOrders", { path: "/o" });
    await expect(c.request("searchOrders", { path: "/o" })).rejects.toBeInstanceOf(ThrottledError);
  });
  it("429 beyond maxWait is a ThrottledError, not a failure", async () => {
    const c = mk((async () => json({}, 429, { "retry-after": "60" })) as typeof fetch);
    await expect(c.request("getReport", { path: "/x" })).rejects.toBeInstanceOf(ThrottledError);
  });
  it("presigned download refuses non-Amazon hosts and sends no token", async () => {
    const c = mk((async () => new Response("x")) as typeof fetch);
    await expect(downloadPresigned(c, "https://evil.example/r")).rejects.toBeInstanceOf(SpApiError);
    await expect(downloadPresigned(c, "http://a.s3.amazonaws.com/r")).rejects.toBeInstanceOf(SpApiError);
    let headers: unknown;
    const c2 = mk((async (_u: unknown, init?: RequestInit) => { headers = init?.headers; return new Response("ok"); }) as typeof fetch);
    await downloadPresigned(c2, "https://bucket.s3.amazonaws.com/r?sig=1");
    expect(JSON.stringify(headers)).not.toContain("x-amz-access-token");
  });
});

describe("orders mapper", () => {
  it("drops buyer and recipient and unlisted fields", () => {
    const o = mapOrder(orders.orders[0], "A21TJRUUN4KGV")!;
    const s = JSON.stringify(o);
    expect(s).not.toMatch(/buyer|Test Buyer|Test Road|recipient|example\.com/i);
    expect(o.orderedValue).toBe(998);
    expect(o.unitCount).toBe(2);
  });
  it("skips orders without required fields and reports the count", async () => {
    let url = "";
    const c = mk((async (u: string) => { url = u; return json(orders); }) as unknown as typeof fetch);
    const page = await searchOrdersPage(c, { marketplaceId: "A21TJRUUN4KGV", lastUpdatedAfter: "2026-10-01T00:00:00Z", lastUpdatedBefore: "2026-11-01T00:00:00Z" });
    expect(page.orders).toHaveLength(1);
    expect(page.skipped).toBe(1);
    expect(page.nextToken).toBe("TOKEN-2");
    expect(url).toContain("/orders/2026-01-01/orders");
    expect(url).not.toContain("includedData");
  });
});

describe("reports and marketplace", () => {
  it("summarizes the listings report by header", () => {
    expect(summarizeListingsReport(tsv)).toMatchObject({ rows: 3, inStock: 1, outOfStock: 2, missingPrice: 1 });
  });
  it("bounds the stored column list", () => {
    const wide = `${Array.from({ length: 300 }, (_, i) => `c${i}${"x".repeat(200)}`).join("	")}
${Array.from({ length: 300 }, () => "1").join("	")}`;
    const out = summarizeListingsReport(wide);
    expect(out.columns).toHaveLength(100);
    expect(out.columns.every((c) => c.length <= 100)).toBe(true);
  });
  it("refuses a report type outside the allow-list", async () => {
    const c = mk((async () => json({ reportId: "1" })) as typeof fetch);
    await expect(createReport(c, "A21TJRUUN4KGV", "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL" as never)).rejects.toThrow();
  });
  it("verifies Amazon India participation", () => {
    const p = { marketplaceId: "A21TJRUUN4KGV", name: null, countryCode: "IN", currencyCode: "INR", domain: null, participating: true, hasSuspendedListings: false, storeName: null };
    expect(verifyMarketplace([p], "A21TJRUUN4KGV").ok).toBe(true);
    expect(verifyMarketplace([{ ...p, countryCode: "US" }], "A21TJRUUN4KGV").ok).toBe(false);
    expect(verifyMarketplace([], "A21TJRUUN4KGV").ok).toBe(false);
  });
  it("redacts tokens", () => {
    expect(redact("refresh_token=Atzr|abc and Bearer xyz", [])).not.toMatch(/Atzr\|abc|xyz/);
  });
  it("gzip helper sanity", () => { expect(gzipSync("a").length).toBeGreaterThan(0); });
});
