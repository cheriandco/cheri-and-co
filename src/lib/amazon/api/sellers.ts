/** Sellers API v1: confirms which marketplaces the seller participates in. Used to verify the configured marketplace id. */
import type { SpApiClient } from "../client";
import { isRec, list, rec, str } from "../parse";
import type { MarketplaceParticipation } from "../types";

export function mapParticipation(raw: unknown): MarketplaceParticipation | null {
  const r = rec(raw);
  const m = rec(r.marketplace);
  const id = str(m.id, 32);
  if (!id) return null;
  const p = rec(r.participation);
  return {
    marketplaceId: id, name: str(m.name, 120), countryCode: str(m.countryCode, 2), currencyCode: str(m.defaultCurrencyCode, 3),
    domain: str(m.domainName, 120), participating: p.isParticipating === true, hasSuspendedListings: p.hasSuspendedListings === true, storeName: str(r.storeName, 200),
  };
}

export async function getMarketplaceParticipations(client: SpApiClient): Promise<MarketplaceParticipation[]> {
  const { data } = await client.request("getMarketplaceParticipations", { path: "/sellers/v1/marketplaceParticipations" });
  const payload = isRec(data) ? data.payload : undefined;
  return list(payload).map(mapParticipation).filter((p): p is MarketplaceParticipation => p !== null);
}

export type MarketplaceCheck =
  | { ok: true; participation: MarketplaceParticipation }
  | { ok: false; reason: string; participation: MarketplaceParticipation | null };

/** The configured id must be listed, be Amazon India (country code IN) and be participating. Never assumes the id is right. */
export function verifyMarketplace(participations: MarketplaceParticipation[], marketplaceId: string, expectedCountry = "IN"): MarketplaceCheck {
  const found = participations.find((p) => p.marketplaceId === marketplaceId) ?? null;
  if (!found) return { ok: false, reason: `The seller account does not list marketplace ${marketplaceId}.`, participation: null };
  if (found.countryCode !== expectedCountry) return { ok: false, reason: `Marketplace ${marketplaceId} is not Amazon India (country ${found.countryCode ?? "unknown"}).`, participation: found };
  if (!found.participating) return { ok: false, reason: "The seller account is not participating in Amazon India.", participation: found };
  return { ok: true, participation: found };
}
