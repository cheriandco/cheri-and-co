/** FBA Inventory API v1 (`getInventorySummaries`). The nextToken lives about 30 seconds, so a whole pass runs inside one call, bounded by `maxPages`. */
import type { SpApiClient } from "../client";
import { iso, isRec, list, qty, rec, str } from "../parse";
import type { AmazonInventoryItem } from "../types";

export function mapInventoryItem(raw: unknown): AmazonInventoryItem | null {
  const r = rec(raw);
  const sku = str(r.sellerSku, 80);
  if (!sku) return null;
  const d = rec(r.inventoryDetails);
  const inbound = (k: string) => qty(d[k]);
  return {
    sellerSku: sku, asin: str(r.asin, 20), fnSku: str(r.fnSku, 20), productName: str(r.productName, 500),
    fulfillable: qty(d.fulfillableQuantity),
    inboundWorking: inbound("inboundWorkingQuantity"), inboundShipped: inbound("inboundShippedQuantity"), inboundReceiving: inbound("inboundReceivingQuantity"),
    reserved: qty(rec(d.reservedQuantity).totalReservedQuantity),
    unfulfillable: qty(rec(d.unfulfillableQuantity).totalUnfulfillableQuantity),
    researching: qty(rec(d.researchingQuantity).totalResearchingQuantity),
    totalQuantity: qty(r.totalQuantity),
    sourceUpdatedAt: iso(r.lastUpdatedTime),
  };
}

export interface InventoryResult { items: AmazonInventoryItem[]; /** True when `maxPages` stopped the pass before Amazon ran out of pages. */ truncated: boolean; skipped: number }

export async function getInventory(client: SpApiClient, marketplaceId: string, maxPages = 20): Promise<InventoryResult> {
  const items: AmazonInventoryItem[] = [];
  let token: string | null = null;
  let skipped = 0;
  let pages = 0;
  do {
    const res: { data: unknown } = await client.request("getInventorySummaries", {
      path: "/fba/inventory/v1/summaries",
      query: { granularityType: "Marketplace", granularityId: marketplaceId, marketplaceIds: [marketplaceId], details: true, nextToken: token ?? undefined },
    });
    const body = isRec(res.data) ? res.data : {};
    const payload = rec(body.payload);
    const raw = list(payload.inventorySummaries);
    const mapped = raw.map(mapInventoryItem).filter((i): i is AmazonInventoryItem => i !== null);
    skipped += raw.length - mapped.length;
    items.push(...mapped);
    token = str(rec(body.pagination).nextToken, 2000);
    pages++;
  } while (token && pages < maxPages);
  return { items, truncated: token !== null, skipped };
}
