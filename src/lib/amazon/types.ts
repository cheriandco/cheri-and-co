/** Typed, whitelisted shapes. Every field here was chosen on purpose; none can hold buyer, recipient or credential data. */

export interface MarketplaceParticipation {
  marketplaceId: string;
  name: string | null;
  countryCode: string | null;
  currencyCode: string | null;
  domain: string | null;
  participating: boolean;
  hasSuspendedListings: boolean;
  storeName: string | null;
}

export interface AmazonOrderItem {
  orderItemId: string;
  asin: string | null;
  sellerSku: string | null;
  title: string | null;
  quantity: number;
  unitPrice: number | null;
  currencyCode: string | null;
}

export interface AmazonOrder {
  amazonOrderId: string;
  marketplaceId: string;
  createdTime: string;
  lastUpdatedTime: string;
  fulfillmentStatus: string;
  fulfilledBy: "MERCHANT" | "AMAZON" | null;
  salesChannel: string | null;
  items: AmazonOrderItem[];
  itemCount: number;
  unitCount: number;
  /** Sum of unit price x quantity as Amazon reports it; null if any line has no price. Not called "revenue": see docs/M5_SANDBOX_CONTRACT.md. */
  orderedValue: number | null;
  currencyCode: string | null;
}

export interface ListingIssue { code: string | null; severity: "ERROR" | "WARNING" | null; message: string | null }

export interface AmazonListing {
  sellerSku: string;
  asin: string | null;
  title: string | null;
  productType: string | null;
  status: string[];
  issues: ListingIssue[];
  errorCount: number;
  warningCount: number;
  imageUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  price: number | null;
  currencyCode: string | null;
  /** Merchant-fulfilled quantity as listed (a listing, not an FBA, figure). */
  listedQuantity: number | null;
}

export interface CatalogEnrichment {
  asin: string;
  brand: string | null;
  title: string | null;
  productType: string | null;
  imageUrl: string | null;
  salesRank: { title: string | null; rank: number }[];
}

export interface AmazonInventoryItem {
  sellerSku: string;
  asin: string | null;
  fnSku: string | null;
  productName: string | null;
  fulfillable: number | null;
  inboundWorking: number | null;
  inboundShipped: number | null;
  inboundReceiving: number | null;
  reserved: number | null;
  unfulfillable: number | null;
  researching: number | null;
  totalQuantity: number | null;
  sourceUpdatedAt: string | null;
}

export type ReportStatus = "IN_QUEUE" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "FATAL";

export interface AmazonReportInfo {
  reportId: string;
  reportType: string | null;
  status: ReportStatus | string;
  reportDocumentId: string | null;
  dataStartTime: string | null;
  dataEndTime: string | null;
}

export interface ListingsReportSummary {
  rows: number;
  columns: string[];
  /** Rows whose quantity column is a number above zero. Null when the report has no quantity column. */
  inStock: number | null;
  outOfStock: number | null;
  missingPrice: number | null;
}
