/** In-memory AmazonRepo for tests. Several repos can share one `MemoryDb`, which is how the isolation tests prove that a repo bound to one
 *  organisation or environment cannot see another's rows. This models the app's scoping rules, not Postgres RLS (see tests/m5-schema-draft.test.ts). */
import type { AmazonRepo, ConnectionPatch, ConnectionRow, InsightRecord, InsightRow, InventoryRow, ProductRow, RunPatch, RunRow, SalesLine, SyncKind } from "@/lib/amazon/repo";
import type { AmazonEnvironment } from "@/lib/amazon/config";
import type { AmazonInventoryItem, AmazonListing, AmazonOrder, AmazonReportInfo, CatalogEnrichment, ListingsReportSummary } from "@/lib/amazon/types";

interface Scoped { org: string; env: AmazonEnvironment; mp: string }

function strip<T extends Scoped>(row: T): Omit<T, keyof Scoped> {
  const copy = { ...row } as Partial<Scoped> & Record<string, unknown>;
  delete copy.org; delete copy.env; delete copy.mp;
  return copy as unknown as Omit<T, keyof Scoped>;
}

export class MemoryDb {
  connections: (Scoped & ConnectionRow)[] = [];
  runs: (Scoped & RunRow)[] = [];
  orders: (Scoped & { order: AmazonOrder; runId: string })[] = [];
  products: (Scoped & ProductRow)[] = [];
  inventory: (Scoped & InventoryRow)[] = [];
  reports: (Scoped & { info: AmazonReportInfo; summary: ListingsReportSummary | null; fetchedAt: string })[] = [];
  insights: (Scoped & InsightRow)[] = [];
  seq = 0;
  /** Counts of writes, so tests can prove a repeated sync writes nothing new. */
  writes = 0;
}

export class MemoryRepo implements AmazonRepo {
  constructor(readonly db: MemoryDb, readonly orgId: string, readonly environment: AmazonEnvironment, readonly marketplaceId = "A21TJRUUN4KGV") {}
  private get s(): Scoped { return { org: this.orgId, env: this.environment, mp: this.marketplaceId }; }
  private mine = <T extends Scoped>(rows: T[]): T[] => rows.filter((r) => r.org === this.orgId && r.env === this.environment && r.mp === this.marketplaceId);

  async getConnection(): Promise<ConnectionRow | null> { return this.mine(this.db.connections)[0] ?? null; }
  async upsertConnection(patch: ConnectionPatch): Promise<void> {
    this.db.writes++;
    const row = this.mine(this.db.connections)[0];
    if (row) { Object.assign(row, patch); return; }
    this.db.connections.push({ ...this.s, environment: this.environment, marketplaceId: this.marketplaceId, marketplaceName: null, countryCode: null, currencyCode: null, storeName: null, sellerId: null,
      participating: null, hasSuspendedListings: null, status: "unverified", verifiedAt: null, lastErrorCode: null, lastErrorAt: null, ordersWatermark: null, catalogSyncedAt: null,
      inventorySyncedAt: null, reportsSyncedAt: null, ...patch });
  }

  async activeRun(kind: SyncKind): Promise<RunRow | null> { return this.mine(this.db.runs).find((r) => r.kind === kind && ["queued", "running", "waiting"].includes(r.status)) ?? null; }
  async createRun(kind: SyncKind, window?: { start: string | null; end: string | null }): Promise<RunRow> {
    if (await this.activeRun(kind)) throw new Error("duplicate active run");
    const now = new Date(Date.UTC(2026, 10, 11, 12, 0, this.db.seq)).toISOString();
    const row = { ...this.s, id: `run-${++this.db.seq}`, kind, status: "queued" as const, cursor: {}, windowStart: window?.start ?? null, windowEnd: window?.end ?? null, counts: {}, errorCode: null, errorMessage: null, startedAt: now, updatedAt: now, finishedAt: null };
    this.db.runs.push(row);
    return row;
  }
  async updateRun(id: string, patch: RunPatch): Promise<void> {
    this.db.writes++;
    const row = this.mine(this.db.runs).find((r) => r.id === id);
    if (!row) throw new Error("run not found in this scope");
    Object.assign(row, patch);
  }
  async recentRuns(limit: number): Promise<RunRow[]> { return [...this.mine(this.db.runs)].reverse().slice(0, limit); }

  async upsertOrders(orders: AmazonOrder[], runId: string): Promise<number> {
    for (const order of orders) {
      const existing = this.mine(this.db.orders).find((o) => o.order.amazonOrderId === order.amazonOrderId);
      if (existing) { existing.order = order; existing.runId = runId; } else this.db.orders.push({ ...this.s, order, runId });
      this.db.writes++;
    }
    return orders.length;
  }
  async upsertListings(listings: AmazonListing[], enrichment: CatalogEnrichment[]): Promise<number> {
    for (const l of listings) {
      const e = enrichment.find((x) => x.asin === l.asin);
      const row: ProductRow = { sellerSku: l.sellerSku, asin: l.asin, title: l.title ?? e?.title ?? null, brand: e?.brand ?? null, productType: l.productType ?? e?.productType ?? null, listingStatus: l.status,
        issueErrorCount: l.errorCount, issueWarningCount: l.warningCount, issues: l.issues, price: l.price, currencyCode: l.currencyCode, salesRank: e?.salesRank ?? null };
      const existing = this.mine(this.db.products).find((p) => p.sellerSku === l.sellerSku);
      if (existing) Object.assign(existing, row); else this.db.products.push({ ...this.s, ...row });
      this.db.writes++;
    }
    return listings.length;
  }
  async upsertInventory(items: AmazonInventoryItem[], source: "fba" | "listing"): Promise<number> {
    for (const it of items) {
      const existing = this.mine(this.db.inventory).find((r) => r.sellerSku === it.sellerSku && r.source === source);
      if (existing) Object.assign(existing, it); else this.db.inventory.push({ ...this.s, ...it, source });
      this.db.writes++;
    }
    return items.length;
  }
  async upsertReport(info: AmazonReportInfo, summary: ListingsReportSummary | null): Promise<void> {
    this.db.writes++;
    const existing = this.mine(this.db.reports).find((r) => r.info.reportId === info.reportId);
    if (existing) { existing.info = info; existing.summary = summary; } else this.db.reports.push({ ...this.s, info, summary, fetchedAt: "2026-11-11T12:00:00.000Z" });
  }

  async salesLines(sinceIso: string): Promise<SalesLine[]> {
    return this.mine(this.db.orders).filter((o) => o.order.createdTime >= sinceIso).flatMap((o) =>
      o.order.items.map((i) => ({ orderedAt: o.order.createdTime, sellerSku: i.sellerSku, asin: i.asin, title: i.title, quantity: i.quantity, unitPrice: i.unitPrice })));
  }
  async orders(limit: number) {
    return this.mine(this.db.orders).map((o) => o.order).sort((a, b) => b.createdTime.localeCompare(a.createdTime)).slice(0, limit)
      .map((o) => ({ amazonOrderId: o.amazonOrderId, createdTime: o.createdTime, fulfillmentStatus: o.fulfillmentStatus, unitCount: o.unitCount, orderedValue: o.orderedValue, currencyCode: o.currencyCode }));
  }
  async products(): Promise<ProductRow[]> { return this.mine(this.db.products).map((r) => strip(r)); }
  async inventory(): Promise<InventoryRow[]> { return this.mine(this.db.inventory).map((r) => strip(r)); }
  async reports(limit: number) {
    return this.mine(this.db.reports).slice(0, limit).map((r) => ({ reportType: r.info.reportType ?? "", amazonReportId: r.info.reportId, status: r.info.status, rowCount: r.summary?.rows ?? null, summary: (r.summary ?? {}) as unknown as Record<string, unknown>, fetchedAt: r.fetchedAt }));
  }

  async saveInsights(insights: InsightRecord[]): Promise<InsightRow[]> {
    const out: InsightRow[] = [];
    for (const i of insights) {
      let row = this.mine(this.db.insights).find((r) => r.dedupeKey === i.dedupeKey);
      if (!row) {
        this.db.writes++;
        row = { ...this.s, ...i, id: `ins-${++this.db.seq}`, status: "draft", approvalId: null, createdAt: "2026-11-11T12:00:00.000Z" };
        this.db.insights.push(row);
      }
      out.push(row);
    }
    return out;
  }
  async insights(): Promise<InsightRow[]> { return this.mine(this.db.insights); }
  async getInsight(id: string): Promise<InsightRow | null> { return this.mine(this.db.insights).find((r) => r.id === id) ?? null; }
  async markInsightSubmitted(id: string, approvalId: string): Promise<void> {
    const row = this.mine(this.db.insights).find((r) => r.id === id);
    if (!row) throw new Error("insight not found in this scope");
    row.status = "submitted"; row.approvalId = approvalId;
  }
}
