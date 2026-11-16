/** Supabase-backed AmazonRepo. Runs as the signed-in user (anon key + session), so Row Level Security applies on top of the scoping done here:
 *  every statement carries `org_id` AND `environment` (and the marketplace), whether reading, upserting or updating. No service-role key. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AmazonEnvironment } from "./config";
import type {
  AmazonRepo, ConnectionPatch, ConnectionRow, InsightRecord, InsightRow, InventoryRow, ProductRow, RunPatch, RunRow, SalesLine, SyncKind,
} from "./repo";
import type { AmazonInventoryItem, AmazonListing, AmazonOrder, AmazonReportInfo, CatalogEnrichment, ListingsReportSummary } from "./types";

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;
/** The slice of the Supabase query builder used here. The project has no generated database types, and the builder's own generics blow up the compiler on wide selects. */
interface Q extends PromiseLike<{ data: unknown; error: DbError }> {
  select(columns?: string): Q; eq(column: string, value: unknown): Q; in(column: string, values: unknown[]): Q; gte(column: string, value: unknown): Q;
  order(column: string, opts?: { ascending: boolean }): Q; limit(n: number): Q; range(from: number, to: number): Q; maybeSingle(): Q; single(): Q;
  insert(row: unknown): Q; update(row: unknown): Q; upsert(rows: unknown, opts?: Record<string, unknown>): Q;
}
const CHUNK = 200;
const PAGE = 1000;
const chunks = <T,>(xs: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK)); return out; };

export class AmazonStoreError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "AmazonStoreError"; }
}

/** Postgres "relation does not exist" / PostgREST "not in schema cache": the Amazon tables have not been installed yet. */
export const isMissingTable = (e: { code?: string; message?: string } | null | undefined): boolean =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /could not find the table|does not exist/i.test(e.message ?? ""));

const iso = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export class SupabaseAmazonRepo implements AmazonRepo {
  constructor(private readonly db: SupabaseClient, readonly orgId: string, readonly environment: AmazonEnvironment, readonly marketplaceId: string) {}

  private fail(error: { code?: string; message: string }): never {
    throw new AmazonStoreError(isMissingTable(error) ? "The Amazon tables are not installed yet." : "Database request failed", error.code);
  }
  private scope(row: Row): Row { return { ...row, org_id: this.orgId, environment: this.environment, marketplace_id: this.marketplaceId }; }
  private t(table: string): Q { return this.db.from(table) as unknown as Q; }
  /** Applies all three scopes to a query. */
  private q(query: Q, withMarketplace = true): Q {
    const base = query.eq("org_id", this.orgId).eq("environment", this.environment);
    return withMarketplace ? base.eq("marketplace_id", this.marketplaceId) : base;
  }
  private async all<T>(table: string, cols: string, order: string, since?: { column: string; value: string }): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = this.q(this.t(table).select(cols));
      if (since) query = query.gte(since.column, since.value);
      const { data, error } = await query.order(order).order("id").range(from, from + PAGE - 1);
      if (error) this.fail(error);
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < PAGE) return out;
      if (out.length > 20_000) throw new AmazonStoreError("Too many rows to read at once.");
    }
  }

  /* ---------- connection ---------- */
  async getConnection(): Promise<ConnectionRow | null> {
    const { data, error } = await this.q(this.t("amazon_connections").select("*")).maybeSingle();
    if (error) this.fail(error);
    if (!data) return null;
    const r = data as Row;
    return {
      environment: this.environment, marketplaceId: this.marketplaceId, marketplaceName: (r.marketplace_name as string) ?? null, countryCode: (r.country_code as string) ?? null,
      currencyCode: (r.currency_code as string) ?? null, storeName: (r.store_name as string) ?? null, sellerId: (r.seller_id as string) ?? null,
      participating: (r.participating as boolean) ?? null, hasSuspendedListings: (r.has_suspended_listings as boolean) ?? null, status: r.status as ConnectionRow["status"],
      verifiedAt: iso(r.verified_at), lastErrorCode: (r.last_error_code as string) ?? null, lastErrorAt: iso(r.last_error_at), ordersWatermark: iso(r.orders_watermark),
      catalogSyncedAt: iso(r.catalog_synced_at), inventorySyncedAt: iso(r.inventory_synced_at), reportsSyncedAt: iso(r.reports_synced_at),
    };
  }
  async upsertConnection(patch: ConnectionPatch): Promise<void> {
    const map: Record<keyof ConnectionPatch, string> = {
      marketplaceName: "marketplace_name", countryCode: "country_code", currencyCode: "currency_code", storeName: "store_name", sellerId: "seller_id", participating: "participating",
      hasSuspendedListings: "has_suspended_listings", status: "status", verifiedAt: "verified_at", lastErrorCode: "last_error_code", lastErrorAt: "last_error_at",
      ordersWatermark: "orders_watermark", catalogSyncedAt: "catalog_synced_at", inventorySyncedAt: "inventory_synced_at", reportsSyncedAt: "reports_synced_at",
    };
    const row: Row = this.scope({ updated_at: new Date().toISOString() });
    for (const [k, col] of Object.entries(map)) if (k in patch) row[col] = (patch as Record<string, unknown>)[k];
    const { error } = await this.t("amazon_connections").upsert(row, { onConflict: "org_id,environment,marketplace_id" });
    if (error) this.fail(error);
  }

  /* ---------- runs ---------- */
  private run(r: Row): RunRow {
    return { id: r.id as string, kind: r.kind as SyncKind, status: r.status as RunRow["status"], cursor: (r.cursor as Record<string, unknown>) ?? {}, windowStart: iso(r.window_start), windowEnd: iso(r.window_end),
      counts: (r.counts as Record<string, number>) ?? {}, errorCode: (r.error_code as string) ?? null, errorMessage: (r.error_message as string) ?? null, startedAt: r.started_at as string,
      updatedAt: r.updated_at as string, finishedAt: iso(r.finished_at) };
  }
  async activeRun(kind: SyncKind): Promise<RunRow | null> {
    const { data, error } = await this.q(this.t("amazon_sync_runs").select("*")).eq("kind", kind).in("status", ["queued", "running", "waiting"]).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (error) this.fail(error);
    return data ? this.run(data as Row) : null;
  }
  async createRun(kind: SyncKind, window?: { start: string | null; end: string | null }): Promise<RunRow> {
    const { data, error } = await this.t("amazon_sync_runs").insert(this.scope({ kind, status: "queued", window_start: window?.start ?? null, window_end: window?.end ?? null })).select("*").single();
    if (error?.code === "23505") { // a parallel request created the active run first: join it instead of failing
      const existing = await this.activeRun(kind);
      if (existing) return existing;
    }
    if (error || !data) this.fail(error ?? { message: "no row" });
    return this.run(data as Row);
  }
  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const row: Row = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.cursor !== undefined) row.cursor = patch.cursor;
    if (patch.windowStart !== undefined) row.window_start = patch.windowStart;
    if (patch.windowEnd !== undefined) row.window_end = patch.windowEnd;
    if (patch.counts !== undefined) row.counts = patch.counts;
    if (patch.errorCode !== undefined) row.error_code = patch.errorCode;
    if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage;
    if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
    const { error } = await this.q(this.t("amazon_sync_runs").update(row)).eq("id", id);
    if (error) this.fail(error);
  }
  async recentRuns(limit: number): Promise<RunRow[]> {
    const { data, error } = await this.q(this.t("amazon_sync_runs").select("*")).order("started_at", { ascending: false }).limit(limit);
    if (error) this.fail(error);
    return ((data ?? []) as Row[]).map((r) => this.run(r));
  }

  /* ---------- synchronised data ---------- */
  async upsertOrders(orders: AmazonOrder[], runId: string): Promise<number> {
    const now = new Date().toISOString();
    for (const part of chunks(orders)) {
      const rows = part.map((o) => this.scope({ amazon_order_id: o.amazonOrderId, created_time: o.createdTime, last_updated_time: o.lastUpdatedTime, fulfillment_status: o.fulfillmentStatus, fulfilled_by: o.fulfilledBy,
        sales_channel: o.salesChannel, item_count: o.itemCount, unit_count: o.unitCount, ordered_value: o.orderedValue, currency_code: o.currencyCode, sync_run_id: runId, synced_at: now }));
      const { error } = await this.t("amazon_orders").upsert(rows, { onConflict: "org_id,environment,marketplace_id,amazon_order_id" });
      if (error) this.fail(error);
      const items = part.flatMap((o) => o.items.map((i) => this.scope({ amazon_order_id: o.amazonOrderId, order_item_id: i.orderItemId, ordered_at: o.createdTime, asin: i.asin, seller_sku: i.sellerSku, title: i.title,
        quantity: i.quantity, unit_price: i.unitPrice, currency_code: i.currencyCode })));
      if (items.length) {
        const res = await this.t("amazon_order_items").upsert(items, { onConflict: "org_id,environment,marketplace_id,amazon_order_id,order_item_id" });
        if (res.error) this.fail(res.error);
      }
    }
    return orders.length;
  }
  async upsertListings(listings: AmazonListing[], enrichment: CatalogEnrichment[]): Promise<number> {
    if (!listings.length) return 0;
    const now = new Date().toISOString();
    const rows = listings.map((l) => {
      const e = enrichment.find((x) => x.asin === l.asin);
      return this.scope({ seller_sku: l.sellerSku, asin: l.asin, title: l.title ?? e?.title ?? null, brand: e?.brand ?? null, product_type: l.productType ?? e?.productType ?? null, image_url: l.imageUrl ?? e?.imageUrl ?? null,
        listing_status: l.status, listing_issues: l.issues, issue_error_count: l.errorCount, issue_warning_count: l.warningCount, sales_rank: e?.salesRank ?? null, price: l.price, currency_code: l.currencyCode,
        listing_created_at: l.createdAt, listing_updated_at: l.updatedAt, synced_at: now });
    });
    const { error } = await this.t("amazon_products").upsert(rows, { onConflict: "org_id,environment,marketplace_id,seller_sku" });
    if (error) this.fail(error);
    return listings.length;
  }
  async upsertInventory(items: AmazonInventoryItem[], source: "fba" | "listing"): Promise<number> {
    const now = new Date().toISOString();
    for (const part of chunks(items)) {
      const rows = part.map((i) => this.scope({ seller_sku: i.sellerSku, source, asin: i.asin, fn_sku: i.fnSku, product_name: i.productName, fulfillable: i.fulfillable, inbound_working: i.inboundWorking,
        inbound_shipped: i.inboundShipped, inbound_receiving: i.inboundReceiving, reserved: i.reserved, unfulfillable: i.unfulfillable, researching: i.researching, total_quantity: i.totalQuantity,
        source_updated_at: i.sourceUpdatedAt, synced_at: now }));
      const { error } = await this.t("amazon_inventory").upsert(rows, { onConflict: "org_id,environment,marketplace_id,seller_sku,source" });
      if (error) this.fail(error);
    }
    return items.length;
  }
  async upsertReport(info: AmazonReportInfo, summary: ListingsReportSummary | null, runId: string): Promise<void> {
    const { error } = await this.t("amazon_reports").upsert(this.scope({ report_type: info.reportType ?? "UNKNOWN", amazon_report_id: info.reportId, document_id: info.reportDocumentId, processing_status: info.status,
      data_start_time: info.dataStartTime, data_end_time: info.dataEndTime, row_count: summary?.rows ?? null, summary: summary ?? {}, sync_run_id: runId, fetched_at: new Date().toISOString() }),
    { onConflict: "org_id,environment,amazon_report_id" });
    if (error) this.fail(error);
  }

  /* ---------- reads ---------- */
  async salesLines(sinceIso: string): Promise<SalesLine[]> {
    const rows = await this.all<Row>("amazon_order_items", "id, ordered_at, seller_sku, asin, title, quantity, unit_price", "ordered_at", { column: "ordered_at", value: sinceIso });
    return rows.map((r) => ({ orderedAt: r.ordered_at as string, sellerSku: (r.seller_sku as string) ?? null, asin: (r.asin as string) ?? null, title: (r.title as string) ?? null, quantity: n(r.quantity) ?? 0, unitPrice: n(r.unit_price) }));
  }
  async orders(limit: number) {
    const { data, error } = await this.q(this.t("amazon_orders").select("amazon_order_id, created_time, fulfillment_status, unit_count, ordered_value, currency_code")).order("created_time", { ascending: false }).limit(limit);
    if (error) this.fail(error);
    return ((data ?? []) as Row[]).map((r) => ({ amazonOrderId: r.amazon_order_id as string, createdTime: r.created_time as string, fulfillmentStatus: r.fulfillment_status as string, unitCount: n(r.unit_count) ?? 0, orderedValue: n(r.ordered_value), currencyCode: (r.currency_code as string) ?? null }));
  }
  async products(): Promise<ProductRow[]> {
    const rows = await this.all<Row>("amazon_products", "id, seller_sku, asin, title, brand, product_type, listing_status, listing_issues, issue_error_count, issue_warning_count, sales_rank, price, currency_code", "seller_sku");
    return rows.map((r) => ({ sellerSku: r.seller_sku as string, asin: (r.asin as string) ?? null, title: (r.title as string) ?? null, brand: (r.brand as string) ?? null, productType: (r.product_type as string) ?? null,
      listingStatus: (r.listing_status as string[]) ?? [], issueErrorCount: n(r.issue_error_count) ?? 0, issueWarningCount: n(r.issue_warning_count) ?? 0, issues: (r.listing_issues as ProductRow["issues"]) ?? [],
      price: n(r.price), currencyCode: (r.currency_code as string) ?? null, salesRank: (r.sales_rank as ProductRow["salesRank"]) ?? null }));
  }
  async inventory(): Promise<InventoryRow[]> {
    const rows = await this.all<Row>("amazon_inventory", "id, seller_sku, source, asin, fn_sku, product_name, fulfillable, inbound_working, inbound_shipped, inbound_receiving, reserved, unfulfillable, researching, total_quantity, source_updated_at", "seller_sku");
    return rows.map((r) => ({ sellerSku: r.seller_sku as string, source: r.source as "fba" | "listing", asin: (r.asin as string) ?? null, fnSku: (r.fn_sku as string) ?? null, productName: (r.product_name as string) ?? null,
      fulfillable: n(r.fulfillable), inboundWorking: n(r.inbound_working), inboundShipped: n(r.inbound_shipped), inboundReceiving: n(r.inbound_receiving), reserved: n(r.reserved),
      unfulfillable: n(r.unfulfillable), researching: n(r.researching), totalQuantity: n(r.total_quantity), sourceUpdatedAt: iso(r.source_updated_at) }));
  }
  async reports(limit: number) {
    const { data, error } = await this.q(this.t("amazon_reports").select("report_type, amazon_report_id, processing_status, row_count, summary, fetched_at"), false).order("fetched_at", { ascending: false }).limit(limit);
    if (error) this.fail(error);
    return ((data ?? []) as Row[]).map((r) => ({ reportType: r.report_type as string, amazonReportId: r.amazon_report_id as string, status: r.processing_status as string, rowCount: n(r.row_count), summary: (r.summary as Record<string, unknown>) ?? {}, fetchedAt: r.fetched_at as string }));
  }

  /* ---------- insights ---------- */
  private insight(r: Row): InsightRow {
    return { id: r.id as string, kind: r.kind as string, severity: r.severity as InsightRow["severity"], title: r.title as string, summary: r.summary as string, recommendation: r.recommendation as string,
      evidence: (r.evidence as unknown[]) ?? [], dedupeKey: r.dedupe_key as string, periodStart: iso(r.period_start), periodEnd: iso(r.period_end), status: r.status as InsightRow["status"], approvalId: (r.approval_id as string) ?? null, createdAt: r.created_at as string };
  }
  async saveInsights(insights: InsightRecord[]): Promise<InsightRow[]> {
    if (!insights.length) return [];
    const rows = insights.map((i) => this.scope({ kind: i.kind, severity: i.severity, title: i.title.slice(0, 200), summary: i.summary.slice(0, 2000), recommendation: i.recommendation.slice(0, 2000), evidence: i.evidence,
      dedupe_key: i.dedupeKey, generated_by: "rules", period_start: i.periodStart, period_end: i.periodEnd }));
    // ignoreDuplicates: an existing insight (same dedupe key) is left exactly as it is, so a submitted one is never reset.
    const { error } = await this.t("amazon_insights").upsert(rows, { onConflict: "org_id,environment,dedupe_key", ignoreDuplicates: true });
    if (error) this.fail(error);
    const { data, error: readError } = await this.q(this.t("amazon_insights").select("*"), false).in("dedupe_key", insights.map((i) => i.dedupeKey));
    if (readError) this.fail(readError);
    return ((data ?? []) as Row[]).map((r) => this.insight(r));
  }
  async insights(): Promise<InsightRow[]> {
    const { data, error } = await this.q(this.t("amazon_insights").select("*"), false).order("created_at", { ascending: false }).limit(200);
    if (error) this.fail(error);
    return ((data ?? []) as Row[]).map((r) => this.insight(r));
  }
  async getInsight(id: string): Promise<InsightRow | null> {
    const { data, error } = await this.q(this.t("amazon_insights").select("*"), false).eq("id", id).maybeSingle();
    if (error) this.fail(error);
    return data ? this.insight(data as Row) : null;
  }
  async markInsightSubmitted(id: string, approvalId: string): Promise<void> {
    const { error } = await this.q(this.t("amazon_insights").update({ status: "submitted", approval_id: approvalId }), false).eq("id", id);
    if (error) this.fail(error);
  }
}
