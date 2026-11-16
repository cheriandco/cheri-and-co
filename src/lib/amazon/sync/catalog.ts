/** Listings + catalog enrichment. Per page: read up to 20 listings, enrich their ASINs in one catalog call, write both, and save the next page token.
 *  A throttle leaves the token where it was, so the page is read again later (idempotent upsert). Merchant-listed quantity is stored as the 'listing' inventory source. */
import { ThrottledError } from "../client";
import { searchListingsPage } from "../api/listings";
import { searchCatalogByAsins } from "../api/catalog";
import { DEFAULT_PAGES_PER_STEP, asString, bump, waiting } from "./shared";
import type { AmazonInventoryItem } from "../types";
import type { ModuleOutcome, StepContext, SyncDeps } from "./types";

export async function catalogStep(deps: SyncDeps, ctx: StepContext): Promise<ModuleOutcome> {
  const { repo, client, sellerId } = deps;
  const counts = { ...ctx.counts };
  if (!sellerId) throw new Error("A seller id is required to read listings (AMAZON_SELLER_ID).");
  let token = asString(ctx.cursor.pageToken);
  const pages = deps.maxPagesPerStep ?? DEFAULT_PAGES_PER_STEP;
  for (let i = 0; i < pages; i++) {
    try {
      const page = await searchListingsPage(client, { sellerId, marketplaceId: repo.marketplaceId, pageToken: token });
      const asins = page.listings.map((l) => l.asin).filter((a): a is string => !!a);
      const enrichment = await searchCatalogByAsins(client, repo.marketplaceId, asins);
      bump(counts, "products", await repo.upsertListings(page.listings, enrichment));
      const listed: AmazonInventoryItem[] = page.listings.filter((l) => l.listedQuantity !== null).map((l) => ({
        sellerSku: l.sellerSku, asin: l.asin, fnSku: null, productName: l.title, fulfillable: l.listedQuantity, inboundWorking: null, inboundShipped: null,
        inboundReceiving: null, reserved: null, unfulfillable: null, researching: null, totalQuantity: l.listedQuantity, sourceUpdatedAt: l.updatedAt,
      }));
      if (listed.length) await repo.upsertInventory(listed, "listing");
      bump(counts, "skipped", page.skipped);
      bump(counts, "pages", 1);
      token = page.nextToken;
      if (!token) return { status: "done", cursor: {}, counts, onDone: () => repo.upsertConnection({ catalogSyncedAt: deps.now().toISOString() }) };
    } catch (e) {
      if (e instanceof ThrottledError) return waiting(e, { pageToken: token }, counts);
      throw e;
    }
  }
  return { status: "more", cursor: { pageToken: token }, counts };
}
