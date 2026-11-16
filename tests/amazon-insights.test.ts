import { describe, expect, it } from "vitest";
import { THRESHOLDS, generateInsights, weekKey, type RulesInput } from "@/lib/amazon/insights/rules";
import type { InventoryRow, ProductRow, SalesLine } from "@/lib/amazon/repo";
import { MemoryDb, MemoryRepo } from "./helpers/amazon-memory-repo";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const dayAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const line = (d: number, sku: string, quantity: number): SalesLine => ({ orderedAt: dayAgo(d), sellerSku: sku, asin: null, title: `Title ${sku}`, quantity, unitPrice: 100 });
const fba = (sku: string, fulfillable: number, extra: Partial<InventoryRow> = {}): InventoryRow => ({ sellerSku: sku, source: "fba", asin: null, fnSku: null, productName: `Name ${sku}`, fulfillable, inboundWorking: 0, inboundShipped: 0,
  inboundReceiving: 0, reserved: 0, unfulfillable: 0, researching: 0, totalQuantity: fulfillable, sourceUpdatedAt: dayAgo(1), ...extra });
const product = (sku: string, e: number, w: number): ProductRow => ({ sellerSku: sku, asin: null, title: `P ${sku}`, brand: null, productType: null, listingStatus: [], issueErrorCount: e, issueWarningCount: w,
  issues: e || w ? [{ code: "90220", severity: e ? "ERROR" : "WARNING", message: "Missing attribute" }] : [], price: 100, currencyCode: "INR", salesRank: null });
const run = (over: Partial<RulesInput>) => generateInsights({ now: NOW, lines: [], products: [], inventory: [], ...over });
const kinds = (r: ReturnType<typeof run>) => r.map((i) => i.kind);

describe("rules-based insights", () => {
  it("produces nothing from no data (never invents)", () => { expect(run({})).toEqual([]); });

  it("top sellers: ranks by units over 30 days and cites each figure", () => {
    const r = run({ lines: [line(2, "A", 10), line(3, "B", 30), line(4, "C", 5), line(5, "D", 1), line(40, "E", 99)] });
    const top = r.find((i) => i.kind === "top_seller")!;
    expect(top.title).toContain("B");
    expect(top.evidence.map((e) => (e as { value: number }).value)).toEqual([30, 10, 5]);
    expect(JSON.stringify(top.evidence)).not.toContain("99"); // outside the 30-day window
  });

  it("sales trend needs a minimum base and a threshold change", () => {
    expect(kinds(run({ lines: [line(5, "A", 3), line(40, "A", 3)] }))).not.toContain("sales_trend");
    const drop = run({ lines: [line(5, "A", 10), line(40, "A", 30)] }).find((i) => i.kind === "sales_trend")!;
    expect(drop).toMatchObject({ severity: "watch" });
    expect(drop.title).toMatch(/down 67%/);
    const rise = run({ lines: [line(5, "A", 30), line(40, "A", 10)] }).find((i) => i.kind === "sales_trend")!;
    expect(rise.severity).toBe("info");
    expect(kinds(run({ lines: [line(5, "A", 11), line(40, "A", 10)] }))).not.toContain("sales_trend"); // +10% < threshold
  });

  it("low inventory: act under 7 days, watch under 14, silent above or without sales", () => {
    const lines = [line(3, "ACT", 30), line(3, "WATCH", 30), line(3, "OK", 30), line(3, "NOSTOCKDATA", 30)];
    const r = run({ lines, inventory: [fba("ACT", 2), fba("WATCH", 10), fba("OK", 100), fba("NOSALES", 0)] }).filter((i) => i.kind === "low_inventory");
    expect(r.map((i) => [i.title.split(":")[1].trim().split(" ")[0] === "Name" ? i.dedupeKey.split(":")[1] : "", i.severity])).toEqual([["ACT", "act"], ["WATCH", "watch"]]);
    expect(r[0].evidence).toHaveLength(3);
  });

  it("inventory risk: unfulfillable or researching stock above a floor or share", () => {
    const r = run({ inventory: [fba("BAD", 20, { unfulfillable: 6 }), fba("SHARE", 10, { researching: 2, totalQuantity: 10 }), fba("FINE", 50, { unfulfillable: 1, totalQuantity: 50 })] }).filter((i) => i.kind === "inventory_risk");
    expect(r.map((i) => i.dedupeKey.split(":")[1]).sort()).toEqual(["BAD", "SHARE"]);
  });

  it("listing issues: errors act, warnings watch, clean listings are silent", () => {
    const r = run({ products: [product("E", 1, 0), product("W", 0, 2), product("CLEAN", 0, 0)] }).filter((i) => i.kind === "listing_issue");
    expect(r.map((i) => [i.dedupeKey.split(":")[1], i.severity])).toEqual([["E", "act"], ["W", "watch"]]);
  });

  it("unusual change flags a spike or a drop in the daily rate", () => {
    const base = [line(20, "A", 14), line(25, "A", 14)]; // 28 units across the 28 days before the last week
    expect(run({ lines: [...base, line(2, "A", 14)] }).find((i) => i.kind === "unusual_change")?.title).toMatch(/spike/);
    expect(run({ lines: base }).find((i) => i.kind === "unusual_change")?.title).toMatch(/drop/);
    expect(kinds(run({ lines: [...base, line(2, "A", 7)] }))).not.toContain("unusual_change"); // steady rate
  });

  it("every insight has evidence with a source, bounded text, a dedupe key and never claims an Amazon action", () => {
    const r = run({
      lines: [line(2, "A", 30), line(5, "A", 5), line(40, "A", 20), line(25, "B", 12)],
      products: [product("A", 1, 1)], inventory: [fba("A", 3, { unfulfillable: 9, totalQuantity: 12 })],
    });
    expect(r.length).toBeGreaterThanOrEqual(5);
    for (const i of r) {
      expect(i.evidence.length, i.kind).toBeGreaterThan(0);
      for (const e of i.evidence as { metric: string; source: string }[]) { expect(e.metric).toBeTruthy(); expect(e.source).toBeTruthy(); }
      expect(i.title.length).toBeLessThanOrEqual(200);
      expect(i.summary.length).toBeLessThanOrEqual(2000);
      expect(i.dedupeKey).toMatch(/:\d{4}-W\d{2}$/);
      expect(`${i.recommendation} ${i.summary}`).not.toMatch(/we (have )?(updated|changed|repriced|deleted|removed)|has been (updated|changed|repriced)/i);
    }
  });

  it("is deterministic and capped per rule", () => {
    const many = Array.from({ length: 30 }, (_, n) => product(`S${n}`, 1, 0));
    const a = run({ products: many }), b = run({ products: many });
    expect(a).toEqual(b);
    expect(a.filter((i) => i.kind === "listing_issue")).toHaveLength(THRESHOLDS.maxPerRule);
  });

  it("week keys are stable within a week and change across weeks", () => {
    expect(weekKey(new Date("2026-11-09T00:00:00Z"))).toBe(weekKey(new Date("2026-11-15T23:00:00Z")));
    expect(weekKey(new Date("2026-11-15T23:00:00Z"))).not.toBe(weekKey(new Date("2026-11-16T00:00:00Z")));
    expect(weekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });
});

describe("saving insights", () => {
  it("regenerating in the same week adds nothing and never resets a submitted insight", async () => {
    const repo = new MemoryRepo(new MemoryDb(), "org-a", "production");
    const fresh = run({ products: [product("E", 1, 0)] });
    const first = await repo.saveInsights(fresh);
    await repo.markInsightSubmitted(first[0].id, "approval-1");
    const again = await repo.saveInsights(fresh);
    expect(again).toHaveLength(first.length);
    expect(await repo.insights()).toHaveLength(first.length);
    expect((await repo.getInsight(first[0].id))?.status).toBe("submitted");
  });
  it("insights are isolated by organisation and environment", async () => {
    const db = new MemoryDb();
    await new MemoryRepo(db, "org-a", "sandbox").saveInsights(run({ products: [product("E", 1, 0)] }));
    expect(await new MemoryRepo(db, "org-a", "production").insights()).toHaveLength(0);
    expect(await new MemoryRepo(db, "org-b", "sandbox").insights()).toHaveLength(0);
    const id = (await new MemoryRepo(db, "org-a", "sandbox").insights())[0].id;
    expect(await new MemoryRepo(db, "org-b", "sandbox").getInsight(id)).toBeNull();
  });
});
