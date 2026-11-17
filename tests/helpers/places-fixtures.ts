/** INVENTED data for the prospecting tests. No real business, number or address appears here, and nothing is copied from Google.
 *  Names use the ".example" domain and obviously fictional text. */
import { sealTransient, type AddressComponent, type GoogleTransient, type GoogleTransientFields } from "@/lib/prospecting/transient";
import type { CampaignLocation } from "@/lib/prospecting/scoring";

export const LOCATIONS: CampaignLocation[] = [
  { city: "Indore", state: "Madhya Pradesh", kind: "target" },
  { city: "Bhopal", state: "Madhya Pradesh", kind: "target" },
  { city: "Nagpur", state: "Maharashtra", kind: "expansion" },
];

export const FETCHED = "2026-11-16T10:00:00.000Z";

export function comps(o: { street?: boolean; city?: string; state?: string }): AddressComponent[] {
  const out: AddressComponent[] = [];
  if (o.street) out.push({ types: ["route"], longText: "Test Road", shortText: "Test Rd" });
  if (o.city) out.push({ types: ["locality", "political"], longText: o.city, shortText: o.city });
  if (o.state) out.push({ types: ["administrative_area_level_1", "political"], longText: o.state, shortText: o.state === "Madhya Pradesh" ? "MP" : undefined });
  return out;
}

export function place(over: Partial<GoogleTransientFields> = {}): GoogleTransient {
  return sealTransient({ placeId: "test-place-0001", types: [], fetchedAt: FETCHED, ...over });
}

/** Worked example 1 of the specification: expected 77, high, needs review. */
export const anaya = (over: Partial<GoogleTransientFields> = {}) => place({
  placeId: "test-anaya-0001", displayName: "Anaya Fashion Jewellery", types: ["jewelry_store", "store", "point_of_interest"], primaryType: "jewelry_store",
  businessStatus: "OPERATIONAL", userRatingCount: 42, rating: 4.4, nationalPhoneNumber: "0731 2345678", websiteUri: "https://anaya.example",
  formattedAddress: "Test Road, Indore, Madhya Pradesh", addressComponents: comps({ street: true, city: "Indore", state: "Madhya Pradesh" }), ...over,
});

/** Worked example 2: gold wording and no fashion signal; expected 59, high, precious-metal flag. */
export const sharma = (over: Partial<GoogleTransientFields> = {}) => place({
  placeId: "test-sharma-0001", displayName: "Sharma Gold and Diamond Jewellers", types: ["jewelry_store", "store"], primaryType: "jewelry_store",
  businessStatus: "OPERATIONAL", userRatingCount: 42, nationalPhoneNumber: "0731 7654321", websiteUri: "https://sharma.example",
  formattedAddress: "Test Road, Bhopal, Madhya Pradesh", addressComponents: comps({ street: true, city: "Bhopal", state: "Madhya Pradesh" }), ...over,
});

/** Worked example 3: no phone, website or ratings, thin address; expected 47, medium. */
export const cityGift = (over: Partial<GoogleTransientFields> = {}) => place({
  placeId: "test-gift-0001", displayName: "City Gift Gallery", types: ["gift_shop", "store"], primaryType: "gift_shop", businessStatus: "OPERATIONAL",
  formattedAddress: "Indore, Madhya Pradesh", addressComponents: comps({ city: "Indore", state: "Madhya Pradesh" }), ...over,
});

/** A unique string used as a fake Google name, phone and site, to prove it never reaches permanent output. */
export const SENTINEL = "ZZTAINT-7f3a91";
