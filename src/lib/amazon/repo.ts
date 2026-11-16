/** Storage interface for synchronised Amazon data. An instance is bound to ONE organisation and ONE environment, so a caller cannot
 *  read or write across either: sandbox and production data never meet, and neither do organisations. Implementations must apply
 *  both scopes to every statement (see supabase-repo.ts and its tests). */
import type { AmazonInventoryItem, AmazonListing, AmazonOrder, CatalogEnrichment, AmazonReportInfo, ListingsReportSummary } from "./types";
import type { AmazonEnvironment } from "./config";

export type SyncKind = "orders" | "catalog" | "inventory" | "reports";
export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed";

export interface ConnectionRow {
  environment: AmazonEnvironment;
  marketplaceId: string;
  marketplaceName: string | null;
  countryCode: string | null;
  currencyCode: string | null;
  storeName: string | null;
  sellerId: string | null;
  participating: boolean | null;
  hasSuspendedListings: boolean | null;
  status: "unverified" | "verified" | "failed";
  verifiedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  ordersWatermark: string | null;
  catalogSyncedAt: string | null;
  inventorySyncedAt: string | null;
  reportsSyncedAt: string | null;
}

export type ConnectionPatch = Partial<Omit<ConnectionRow, "environment" | "marketplaceId">>;

export interface RunRow {
  id: string;
  kind: SyncKind;
  status: RunStatus;
  cursor: Record<string, unknown>;
  windowStart: string | null;
  windowEnd: string | null;
  counts: Record<string, number>;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type RunPatch = Partial<Pick<RunRow, "status" | "cursor" | "windowStart" | "windowEnd" | "counts" | "errorCode" | "errorMessage" | "finishedAt">>;

export interface SalesLine { orderedAt: string; sellerSku: string | null; asin: string | null; title: string | null; quantity: number; unitPrice: number | null }

export interface ProductRow {
  sellerSku: string; asin: string | null; title: string | null; brand: string | null; productType: string | null;
  listingStatus: string[]; issueErrorCount: number; issueWarningCount: number; issues: { code: string | null; severity: string | null; message: string | null }[];
  price: number | null; currencyCode: string | null; salesRank: { title: string | null; rank: number }[] | null;
}

export interface InventoryRow extends AmazonInventoryItem { source: "fba" | "listing" }

export interface InsightRecord {
  kind: string; severity: "info" | "watch" | "act"; title: string; summary: string; recommendation: string;
  evidence: unknown[]; dedupeKey: string; periodStart: string | null; periodEnd: string | null;
}
export interface InsightRow extends InsightRecord { id: string; status: "draft" | "submitted" | "dismissed"; approvalId: string | null; createdAt: string }

export interface AmazonRepo {
  readonly orgId: string;
  readonly environment: AmazonEnvironment;
  readonly marketplaceId: string;

  getConnection(): Promise<ConnectionRow | null>;
  upsertConnection(patch: ConnectionPatch): Promise<void>;

  /** The queued/running/waiting run of this kind, if any (at most one exists). */
  activeRun(kind: SyncKind): Promise<RunRow | null>;
  createRun(kind: SyncKind, window?: { start: string | null; end: string | null }): Promise<RunRow>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  recentRuns(limit: number): Promise<RunRow[]>;

  /** Upserts by (org, environment, marketplace, order id); items by their own key. Returns how many orders were written. */
  upsertOrders(orders: AmazonOrder[], runId: string): Promise<number>;
  upsertListings(listings: AmazonListing[], enrichment: CatalogEnrichment[]): Promise<number>;
  upsertInventory(items: AmazonInventoryItem[], source: "fba" | "listing"): Promise<number>;
  upsertReport(info: AmazonReportInfo, summary: ListingsReportSummary | null, runId: string): Promise<void>;

  salesLines(sinceIso: string): Promise<SalesLine[]>;
  orders(limit: number): Promise<{ amazonOrderId: string; createdTime: string; fulfillmentStatus: string; unitCount: number; orderedValue: number | null; currencyCode: string | null }[]>;
  products(): Promise<ProductRow[]>;
  inventory(): Promise<InventoryRow[]>;
  reports(limit: number): Promise<{ reportType: string; amazonReportId: string; status: string; rowCount: number | null; summary: Record<string, unknown>; fetchedAt: string }[]>;

  /** Inserts new insights and leaves existing ones (same dedupe key) untouched, so regenerating never duplicates and never un-submits. Returns rows now stored for the keys. */
  saveInsights(insights: InsightRecord[]): Promise<InsightRow[]>;
  insights(): Promise<InsightRow[]>;
  getInsight(id: string): Promise<InsightRow | null>;
  markInsightSubmitted(id: string, approvalId: string): Promise<void>;
}
