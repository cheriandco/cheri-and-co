/** Shapes handed to the Amazon dashboard (live organisations only). */
import type { AmazonEnvironment } from "./config";
import type { ConnectionRow, InsightRow, InventoryRow, ProductRow, RunRow } from "./repo";

export interface AmazonOverview {
  /** Window the figures cover. */
  days: 30;
  unitsOrdered: number;
  /** Sum of unit price x quantity for lines that carry a price, in `currencyCode`. This is ordered value, not revenue (returns, cancellations and fees are not netted out). */
  orderedValue: number | null;
  currencyCode: string | null;
  orderCount: number;
  /** True when more orders exist than were counted. */
  orderCountCapped: boolean;
  listings: number;
  listingsWithErrors: number;
  fbaFulfillableUnits: number | null;
  topSkus: { sku: string; title: string | null; units: number }[];
}

export type AmazonLiveView =
  | { state: "unconfigured"; message: string }
  | { state: "tables_missing"; environment: AmazonEnvironment; message: string }
  | {
      state: "ready";
      environment: AmazonEnvironment;
      /** Sandbox data is Amazon's simulated test data, never real sales. */
      simulated: boolean;
      marketplaceId: string;
      connection: ConnectionRow | null;
      canSync: boolean;
      /** May send an insight to Approvals (owner, admin, approver, staff). */
      canQueue: boolean;
      runs: RunRow[];
      overview: AmazonOverview;
      orders: { amazonOrderId: string; createdTime: string; fulfillmentStatus: string; unitCount: number; orderedValue: number | null; currencyCode: string | null }[];
      products: ProductRow[];
      inventory: InventoryRow[];
      reports: { reportType: string; amazonReportId: string; status: string; rowCount: number | null; summary: Record<string, unknown>; fetchedAt: string }[];
      insights: InsightRow[];
    };

export class AmazonConfigError extends Error {
  constructor(message: string) { super(message); this.name = "AmazonConfigError"; }
}
