// Sync modules against DOCUMENTATION-DERIVED fixtures (tests/fixtures/amazon). None of this is an Amazon sandbox response.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { syncStep, verifyConnection } from "@/lib/amazon/sync/run";
import type { SyncDeps } from "@/lib/amazon/sync/types";
import { MemoryDb, MemoryRepo } from "./helpers/amazon-memory-repo";
import { fakeAmazon, type FakeOptions } from "./helpers/amazon-fake-api";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const orders1 = JSON.parse(readFileSync("tests/fixtures/amazon/orders.json", "utf8"));
const orders2 = { orders: [{ orderId: "171-0000000-0000002", createdTime: "2026-11-02T05:00:00Z", lastUpdatedTime: "2026-11-02T06:00:00Z", fulfillment: { fulfillmentStatus: "PENDING" },
  orderItems: [{ orderItemId: "1", quantityOrdered: 1, product: { asin: "B000TEST02", sellerSku: "SKU-2", title: "Chain", price: { unitPrice: { amount: "250", currencyCode: "INR" } } } }] }], pagination: {} };
const PAGES = { "": orders1, "TOKEN-2": orders2 };

function setup(opts: FakeOptions = {}, db = new MemoryDb(), org = "org-a", env: "sandbox" | "production" = "sandbox", maxPagesPerStep?: number) {
  const api = fakeAmazon(opts);
  const repo = new MemoryRepo(db, org, env);
  const deps: SyncDeps = { client: api.client, repo, sellerId: "SELLER1", now: () => NOW, maxPagesPerStep };
  return { api, repo, deps, db };
}
async function verified(opts: FakeOptions = {}, maxPagesPerStep?: number) {
  const s = setup(opts, undefined, "org-a", "sandbox", maxPagesPerStep);
  expect((await verifyConnection(s.deps)).ok).toBe(true);
  return s;
}
async function drain(deps: SyncDeps, kind: Parameters<typeof syncStep>[1]) {
  for (let i = 0; i < 20; i++) { const r = await syncStep(deps, kind); if (r.status === "done" || r.status === "failed") return r; }
  throw new Error("did not finish");
}

describe("connection verification", () => {
  it("records a verified Amazon India connection", async () => {
    const { repo } = await verified();
    expect(await repo.getConnection()).toMatchObject({ status: "verified", countryCode: "IN", currencyCode: "INR", participating: true, environment: "sandbox" });
  });
  it("fails clearly when the configured marketplace is not listed", async () => {
    const s = setup();
    const other = new MemoryRepo(s.db, "org-a", "sandbox", "ATVPDKIKX0DER");
    const r = await verifyConnection({ ...s.deps, repo: other });
    expect(r.ok).toBe(false);
    expect((await other.getConnection())?.status).toBe("failed");
  });
  it("refuses to sync before the connection is verified", async () => {
    const s = setup();
    expect((await syncStep(s.deps, "orders")).status).toBe("failed");
    expect(s.api.calls).toHaveLength(0);
  });
});

describe("orders sync", () => {
  it("reads every page, drops buyer data, advances the watermark and is idempotent", async () => {
    const { deps, repo, api, db } = await verified({ orderPages: PAGES });
    const r = await drain(deps, "orders");
    expect(r).toMatchObject({ status: "done", counts: { orders: 2, skipped: 1, pages: 2 } });
    expect(db.orders).toHaveLength(2);
    expect(JSON.stringify(db.orders)).not.toMatch(/buyer|recipient|Test Road|example\.com/i);
    const conn = await repo.getConnection();
    expect(conn?.ordersWatermark).toBe("2026-11-11T11:55:00.000Z");
    const orderCalls = api.calls.filter((c) => c.url.includes("/orders/2026-01-01/orders"));
    expect(orderCalls.every((c) => !c.url.includes("includedData"))).toBe(true);
    expect(orderCalls[1].url).toContain("paginationToken=TOKEN-2");
    // immediately again: the window is empty (start = end), so nothing is requested
    const before = api.calls.length;
    expect((await drain(deps, "orders")).status).toBe("done");
    expect(api.calls.length).toBe(before);
    // an hour later: same data comes back, no duplicates; the window starts at the watermark
    await drain({ ...deps, now: () => new Date(NOW.getTime() + 3_600_000) }, "orders");
    expect(db.orders).toHaveLength(2);
    expect(db.runs.filter((x) => x.kind === "orders")).toHaveLength(3);
    const second = api.calls.filter((c) => c.url.includes("/orders/2026-01-01/orders")).at(-2)!;
    expect(decodeURIComponent(second.url)).toContain("lastUpdatedAfter=2026-11-11T11:55:00.000Z");
  });
  it("is bounded per step and resumes from the saved token", async () => {
    const { deps, db } = await verified({ orderPages: PAGES }, 1);
    const first = await syncStep(deps, "orders");
    expect(first.status).toBe("more");
    expect(db.runs[0].cursor).toMatchObject({ nextToken: "TOKEN-2" });
    expect(db.orders).toHaveLength(1);
    const second = await syncStep(deps, "orders");
    expect(second.status).toBe("done");
    expect(db.runs).toHaveLength(1); // the same run continued
    expect(db.runs[0].status).toBe("succeeded");
  });
  it("treats a rate limit as waiting, keeps its place, and resumes", async () => {
    const throttled = await verified({ orderPages: PAGES, throttle: ["/orders/"] }, 1);
    // first page fine? no: everything on the orders path is throttled
    const w = await syncStep(throttled.deps, "orders");
    expect(w.status).toBe("waiting");
    expect(w.retryAfterMs).toBeGreaterThan(60_000);
    expect(throttled.db.runs[0]).toMatchObject({ status: "waiting" });
    expect(throttled.db.orders).toHaveLength(0);
    // later, the limit has lifted: a fresh client against the same database resumes the SAME run
    const later = setup({ orderPages: PAGES }, throttled.db, "org-a", "sandbox");
    const done = await drain(later.deps, "orders");
    expect(done.status).toBe("done");
    expect(throttled.db.runs.filter((r) => r.kind === "orders")).toHaveLength(1);
  });
  it("records a failure without leaking secrets and keeps the connection error", async () => {
    const { deps, db, repo } = await verified({ forbid: ["/orders/"] });
    const r = await syncStep(deps, "orders");
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/403|roles/);
    expect(JSON.stringify([r, db.runs])).not.toMatch(/Atza|TEST-ACCESS/);
    expect(db.runs[0]).toMatchObject({ status: "failed" });
    expect((await repo.getConnection())?.lastErrorCode).toBeTruthy();
  });
});

describe("catalog, inventory and reports sync", () => {
  it("stores listings with catalog enrichment and listing issues, idempotently", async () => {
    const { deps, repo, db } = await verified();
    expect((await drain(deps, "catalog")).status).toBe("done");
    const products = await repo.products();
    expect(products).toHaveLength(2);
    expect(products.find((p) => p.sellerSku === "SKU-1")).toMatchObject({ brand: "Cheri", price: 499, salesRank: [{ rank: 120 }] });
    expect(products.find((p) => p.sellerSku === "SKU-2")).toMatchObject({ issueErrorCount: 1, issueWarningCount: 1 });
    expect((await repo.inventory()).filter((i) => i.source === "listing")).toHaveLength(1);
    await drain(deps, "catalog");
    expect(db.products).toHaveLength(2);
    expect((await repo.getConnection())?.catalogSyncedAt).toBe(NOW.toISOString());
  });
  it("pages through FBA inventory in one pass and skips rows without a SKU", async () => {
    const { deps, repo } = await verified();
    const r = await drain(deps, "inventory");
    expect(r).toMatchObject({ status: "done", counts: { items: 3, skipped: 1 } });
    const inv = await repo.inventory();
    expect(inv.map((i) => i.sellerSku).sort()).toEqual(["SKU-1", "SKU-3", "SKU-9"]);
    expect(inv.find((i) => i.sellerSku === "SKU-1")).toMatchObject({ fulfillable: 4, unfulfillable: 4, source: "fba" });
  });
  it("creates, polls and summarizes a report, downloading without the Amazon token", async () => {
    const { deps, repo, api } = await verified({ reportStatuses: ["IN_QUEUE", "IN_PROGRESS", "DONE"] });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) { const r = await syncStep(deps, "reports"); seen.push(r.status); if (r.status === "done") break; }
    expect(seen).toEqual(["waiting", "waiting", "waiting", "done"]);
    const rep = await repo.reports(5);
    expect(rep[0]).toMatchObject({ amazonReportId: "R1", status: "DONE", rowCount: 3 });
    const download = api.calls.find((c) => c.url.includes("amazonaws.com"))!;
    expect(JSON.stringify(download.headers)).not.toContain("x-amz-access-token");
    expect(api.calls.filter((c) => !c.url.includes("amazonaws.com")).every((c) => c.headers["x-amz-access-token"])).toBe(true);
  });
  it("fails a cancelled report instead of storing nothing silently", async () => {
    const { deps } = await verified({ reportStatuses: ["FATAL"] });
    await syncStep(deps, "reports");
    expect((await syncStep(deps, "reports")).status).toBe("failed");
  });
});

describe("isolation by organisation and environment", () => {
  it("never shares rows between organisations", async () => {
    const db = new MemoryDb();
    const a = setup({ orderPages: PAGES }, db, "org-a");
    await verifyConnection(a.deps);
    await drain(a.deps, "orders"); await drain(a.deps, "catalog"); await drain(a.deps, "inventory");
    const b = new MemoryRepo(db, "org-b", "sandbox");
    expect(await b.getConnection()).toBeNull();
    expect(await b.orders(50)).toHaveLength(0);
    expect(await b.products()).toHaveLength(0);
    expect(await b.inventory()).toHaveLength(0);
    expect(await b.recentRuns(10)).toHaveLength(0);
    await expect(b.updateRun(db.runs[0].id, { status: "failed" })).rejects.toThrow();
  });
  it("keeps sandbox and production strictly separate for the same organisation", async () => {
    const db = new MemoryDb();
    const sb = setup({ orderPages: PAGES }, db, "org-a", "sandbox");
    await verifyConnection(sb.deps); await drain(sb.deps, "orders");
    const prod = new MemoryRepo(db, "org-a", "production");
    expect(await prod.getConnection()).toBeNull();
    expect(await prod.orders(50)).toHaveLength(0);
    expect(await prod.salesLines("2000-01-01T00:00:00Z")).toHaveLength(0);
    // production gets its own run and watermark; the sandbox watermark is untouched
    const p = setup({ orderPages: PAGES }, db, "org-a", "production");
    await verifyConnection(p.deps); await drain(p.deps, "orders");
    expect(db.orders.map((o) => o.env).sort()).toEqual(["production", "production", "sandbox", "sandbox"]);
    expect(db.runs.filter((r) => r.env === "production")).toHaveLength(1);
  });
  it("allows only one active run per kind", async () => {
    const { repo } = await verified();
    await repo.createRun("orders");
    await expect(repo.createRun("orders")).rejects.toThrow();
  });
});
