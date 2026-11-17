/** Field-mask abstraction. Google bills a request at the most expensive field tier in its mask (UNVERIFIED), and returns only what the
 *  mask names, so the mask is the single place that decides which Google content ever enters the system. It is a closed whitelist:
 *  unknown fields (reviews, photos, opening hours, editorial text and anything else) cannot be requested.
 *
 *  Stage 1 (search) uses the cheapest set that supports the geography, status and type pre-filter. Stage 2 (details) adds contact fields
 *  and runs only for candidates that survive stage 1 (specification section 5.3). */

export const SEARCH_FIELDS = ["id", "displayName", "formattedAddress", "addressComponents", "location", "types", "primaryType", "businessStatus"] as const;
export const DETAILS_FIELDS = ["id", "websiteUri", "nationalPhoneNumber", "rating", "userRatingCount"] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];
export type DetailsField = (typeof DETAILS_FIELDS)[number];
export type MaskStage = "search" | "details";

/** Google's published billing tiers by field, from memory (UNVERIFIED until the Phase 8 contract check). */
export type FieldTier = "ids_only" | "pro" | "enterprise";
const TIER: Record<SearchField | DetailsField, FieldTier> = {
  id: "ids_only",
  displayName: "pro", formattedAddress: "pro", addressComponents: "pro", location: "pro", types: "pro", primaryType: "pro", businessStatus: "pro",
  websiteUri: "enterprise", nationalPhoneNumber: "enterprise", rating: "enterprise", userRatingCount: "enterprise",
};
const RANK: Record<FieldTier, number> = { ids_only: 0, pro: 1, enterprise: 2 };

export class FieldMaskError extends Error {
  constructor(message: string) { super(message); this.name = "FieldMaskError"; }
}

export interface FieldMask {
  stage: MaskStage;
  fields: readonly string[];
  /** The exact header value to send. Search masks are prefixed `places.` and end with `nextPageToken`; details masks are bare. */
  header: string;
  tier: FieldTier;
}

/** Builds a mask from a subset of the stage's allowed fields (all of them by default). `id` is always included. */
export function buildFieldMask(stage: MaskStage, wanted?: readonly string[]): FieldMask {
  const allowed: readonly string[] = stage === "search" ? SEARCH_FIELDS : DETAILS_FIELDS;
  const list = wanted ?? allowed;
  for (const f of list) if (!allowed.includes(f)) throw new FieldMaskError(`Field "${String(f).slice(0, 40)}" is not allowed in a ${stage} mask.`);
  const fields = ["id", ...list.filter((f) => f !== "id")].filter((f, i, a) => a.indexOf(f) === i);
  const tier = fields.reduce<FieldTier>((t, f) => (RANK[TIER[f as SearchField | DetailsField]] > RANK[t] ? TIER[f as SearchField | DetailsField] : t), "ids_only");
  const header = stage === "search" ? [...fields.map((f) => `places.${f}`), "nextPageToken"].join(",") : fields.join(",");
  return { stage, fields, header, tier };
}

export const isAllowedField = (stage: MaskStage, f: string): boolean => (stage === "search" ? SEARCH_FIELDS : DETAILS_FIELDS).some((x) => x === f);
