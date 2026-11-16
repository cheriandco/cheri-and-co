/** Catalog Items API 2022-04-01 (`searchCatalogItems`): enrichment of our own ASINs (brand, type, image, sales rank). Read-only. */
import type { SpApiClient } from "../client";
import { int, isRec, list, rec, str } from "../parse";
import type { CatalogEnrichment } from "../types";

export const CATALOG_BATCH = 20;

export function mapCatalogItem(raw: unknown, marketplaceId: string): CatalogEnrichment | null {
  const r = rec(raw);
  const asin = str(r.asin, 20);
  if (!asin) return null;
  const pick = (key: string): Record<string, unknown> => {
    const all = list(r[key]).map(rec);
    return all.find((x) => x.marketplaceId === marketplaceId) ?? all[0] ?? {};
  };
  const summary = pick("summaries");
  const images = list(pick("images").images).map(rec);
  const main = images.find((i) => i.variant === "MAIN") ?? images[0];
  const link = str(main?.link, 1000);
  const ranks = list(pick("salesRanks").classificationRanks).map(rec)
    .map((x) => ({ title: str(x.title, 200), rank: int(x.rank) }))
    .filter((x): x is { title: string | null; rank: number } => x.rank !== null && x.rank > 0)
    .slice(0, 5);
  return { asin, brand: str(summary.brand, 200), title: str(summary.itemName, 500), productType: str(summary.productType, 100), imageUrl: link && link.startsWith("https://") ? link : null, salesRank: ranks };
}

/** Looks up at most 20 ASINs per call (Amazon's limit). Callers batch; this refuses to send more. */
export async function searchCatalogByAsins(client: SpApiClient, marketplaceId: string, asins: string[]): Promise<CatalogEnrichment[]> {
  const unique = [...new Set(asins.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  if (unique.length > CATALOG_BATCH) throw new Error(`searchCatalogByAsins accepts at most ${CATALOG_BATCH} ASINs per call.`);
  const { data } = await client.request("searchCatalogItems", {
    path: "/catalog/2022-04-01/items",
    query: { marketplaceIds: [marketplaceId], identifiers: unique, identifiersType: "ASIN", includedData: ["summaries", "salesRanks", "images"], pageSize: CATALOG_BATCH },
  });
  const body = isRec(data) ? data : {};
  return list(body.items).map((i) => mapCatalogItem(i, marketplaceId)).filter((c): c is CatalogEnrichment => c !== null);
}
