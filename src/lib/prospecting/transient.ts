/** CLASS G: Google-sourced, transient data (specification section 6.2).
 *
 *  A `GoogleTransient` value carries content returned by the Places API. It may be held in memory and, in a later phase, in the one
 *  transient cache table that expires within 30 days. It is a **distinct branded type**: no function that writes permanent CRM data
 *  accepts it (see `human.ts`), and nothing here is ever logged, put in an error message, or copied into an approval, task, activity row,
 *  draft or fixture. Only `placeId` is permitted to persist. Anything absent from Google's answer stays `undefined` (unknown), never assumed. */

export const DEFAULT_CACHE_DAYS = 7;
/** Mirrors the planned database check `expires_at <= fetched_at + interval '30 days'`. */
export const MAX_CACHE_DAYS = 30;

export type BusinessStatus = "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY";

export interface AddressComponent { longText?: string; shortText?: string; types: readonly string[] }

export interface GoogleTransientFields {
  /** The only field allowed to persist (class P). */
  placeId: string;
  displayName?: string;
  formattedAddress?: string;
  addressComponents?: readonly AddressComponent[];
  location?: { latitude: number; longitude: number };
  types: readonly string[];
  primaryType?: string;
  businessStatus?: BusinessStatus;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  /** ISO timestamp of the response this data came from. */
  fetchedAt: string;
}

declare const transientBrand: unique symbol;
export type GoogleTransient = Readonly<GoogleTransientFields> & { readonly [transientBrand]: true };

/** The only way to make a `GoogleTransient`. Used by the response mappers (and by tests with invented data). Copies and freezes. */
export function sealTransient(fields: GoogleTransientFields): GoogleTransient {
  const copy: GoogleTransientFields = {
    ...fields,
    types: [...fields.types],
    addressComponents: fields.addressComponents?.map((c) => ({ ...c, types: [...c.types] })),
    location: fields.location ? { ...fields.location } : undefined,
  };
  return Object.freeze(copy) as GoogleTransient;
}

/** Combines a search result with a later details result. Defined details fields win; the newer `fetchedAt` is kept. */
export function mergeTransient(base: GoogleTransient, extra: GoogleTransient): GoogleTransient {
  if (base.placeId !== extra.placeId) throw new Error("Cannot merge data for two different places.");
  const pick = <K extends keyof GoogleTransientFields>(k: K): GoogleTransientFields[K] => (extra[k] !== undefined ? extra[k] : base[k]);
  return sealTransient({
    placeId: base.placeId,
    displayName: pick("displayName"), formattedAddress: pick("formattedAddress"), addressComponents: pick("addressComponents"),
    location: pick("location"), types: extra.types.length ? extra.types : base.types, primaryType: pick("primaryType"),
    businessStatus: pick("businessStatus"), nationalPhoneNumber: pick("nationalPhoneNumber"), websiteUri: pick("websiteUri"),
    rating: pick("rating"), userRatingCount: pick("userRatingCount"),
    fetchedAt: extra.fetchedAt > base.fetchedAt ? extra.fetchedAt : base.fetchedAt,
  });
}

/** The expiry for data fetched at `fetchedAt`: `days` clamped to 1..30 (never later than the planned database maximum). */
export function expiresAtFor(fetchedAt: string, days: number = DEFAULT_CACHE_DAYS): string {
  const d = Number.isFinite(days) ? Math.min(MAX_CACHE_DAYS, Math.max(1, Math.floor(days))) : DEFAULT_CACHE_DAYS;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) throw new Error("fetchedAt must be an ISO timestamp.");
  return new Date(t + d * 86_400_000).toISOString();
}

/** True while the data is inside its cache window. Expired data must be treated as absent. */
export function isFresh(expiresAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t > now.getTime();
}
