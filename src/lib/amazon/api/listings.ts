/** Listings Items API 2021-08-01 (`searchListingsItems`): the seller's own listings, their status and any listing issues. Read-only. */
import type { SpApiClient } from "../client";
import { iso, isRec, list, money, qty, rec, str } from "../parse";
import type { AmazonListing, ListingIssue } from "../types";

export interface ListingsPage { listings: AmazonListing[]; nextToken: string | null; skipped: number }

const httpsOnly = (v: unknown): string | null => { const s = str(v, 1000); return s && s.startsWith("https://") ? s : null; };

export function mapListing(raw: unknown, marketplaceId: string): AmazonListing | null {
  const r = rec(raw);
  const sku = str(r.sku, 80);
  if (!sku) return null;
  const summaries = list(r.summaries).map(rec);
  const summary = summaries.find((s) => s.marketplaceId === marketplaceId) ?? summaries[0] ?? {};
  const issues: ListingIssue[] = list(r.issues).map(rec).map((i) => {
    const sev = str(i.severity, 10);
    return { code: str(i.code, 100), severity: sev === "ERROR" || sev === "WARNING" ? sev : null, message: str(i.message, 300) };
  });
  const offer = list(r.offers).map(rec).find((o) => o.marketplaceId === marketplaceId) ?? list(r.offers).map(rec)[0];
  const price = money(rec(offer?.price));
  const merchantQty = list(r.fulfillmentAvailability).map(rec).filter((f) => !(str(f.fulfillmentChannelCode, 40) ?? "").toUpperCase().startsWith("AMAZON")).map((f) => qty(f.quantity));
  const known = merchantQty.filter((n): n is number => n !== null);
  return {
    sellerSku: sku, asin: str(summary.asin, 20), title: str(summary.itemName, 500), productType: str(summary.productType, 100),
    status: list(summary.status).filter((x): x is string => typeof x === "string").slice(0, 5),
    issues: issues.slice(0, 50),
    errorCount: issues.filter((i) => i.severity === "ERROR").length,
    warningCount: issues.filter((i) => i.severity === "WARNING").length,
    imageUrl: httpsOnly(rec(summary.mainImage).link), createdAt: iso(summary.createdDate), updatedAt: iso(summary.lastUpdatedDate),
    price: price.amount, currencyCode: price.currency,
    listedQuantity: known.length ? known.reduce((a, b) => a + b, 0) : null,
  };
}

export async function searchListingsPage(client: SpApiClient, q: { sellerId: string; marketplaceId: string; pageToken?: string | null }): Promise<ListingsPage> {
  const { data } = await client.request("searchListingsItems", {
    path: `/listings/2021-08-01/items/${encodeURIComponent(q.sellerId)}`,
    query: { marketplaceIds: [q.marketplaceId], includedData: ["summaries", "issues", "offers", "fulfillmentAvailability"], pageSize: 20, pageToken: q.pageToken ?? undefined },
  });
  const body = isRec(data) ? data : {};
  const raw = list(body.items);
  const listings = raw.map((i) => mapListing(i, q.marketplaceId)).filter((l): l is AmazonListing => l !== null);
  return { listings, nextToken: str(rec(body.pagination).nextToken, 2000), skipped: raw.length - listings.length };
}
