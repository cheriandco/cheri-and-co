/** Whitelist mappers: turn an untrusted Places response into `GoogleTransient` values by copying NAMED fields only, with type checks and
 *  length caps. Unknown fields are dropped. A missing or malformed field is unknown (`undefined`), never guessed. Never throws on partial
 *  data; an entry without a usable Place ID is dropped and counted. */
import { sealTransient, type AddressComponent, type BusinessStatus, type GoogleTransient } from "../transient";

const MAX_TEXT = 500;
const MAX_ADDRESS = 1000;
const MAX_TYPES = 50;
const MAX_COMPONENTS = 30;
const MAX_TOKEN = 4096;
const PLACE_ID = /^[A-Za-z0-9_-]{5,300}$/;

const BUSINESS_STATUS: readonly BusinessStatus[] = ["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const isValidPlaceId = (v: unknown): v is string => typeof v === "string" && PLACE_ID.test(v);

/** Places (New) sends `displayName` as `{ text, languageCode }`; a bare string is accepted too. */
function displayName(v: unknown): string | undefined {
  if (typeof v === "string") return str(v, MAX_TEXT);
  return isRecord(v) ? str(v.text, MAX_TEXT) : undefined;
}

function components(v: unknown): AddressComponent[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AddressComponent[] = [];
  for (const c of v.slice(0, MAX_COMPONENTS)) {
    if (!isRecord(c) || !Array.isArray(c.types)) continue;
    const types = c.types.filter((t): t is string => typeof t === "string").slice(0, 10);
    if (!types.length) continue;
    out.push({ longText: str(c.longText, MAX_TEXT), shortText: str(c.shortText, MAX_TEXT), types });
  }
  return out.length ? out : undefined;
}

function location(v: unknown): { latitude: number; longitude: number } | undefined {
  if (!isRecord(v)) return undefined;
  const latitude = num(v.latitude), longitude = num(v.longitude);
  if (latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/** Maps one place object. Returns undefined when it has no valid Place ID. */
export function mapPlace(raw: unknown, fetchedAt: string): GoogleTransient | undefined {
  if (!isRecord(raw) || !isValidPlaceId(raw.id)) return undefined;
  const status = typeof raw.businessStatus === "string" && (BUSINESS_STATUS as readonly string[]).includes(raw.businessStatus) ? (raw.businessStatus as BusinessStatus) : undefined;
  const rating = num(raw.rating);
  const count = num(raw.userRatingCount);
  return sealTransient({
    placeId: raw.id,
    displayName: displayName(raw.displayName),
    formattedAddress: str(raw.formattedAddress, MAX_ADDRESS),
    addressComponents: components(raw.addressComponents),
    location: location(raw.location),
    types: Array.isArray(raw.types) ? raw.types.filter((t): t is string => typeof t === "string").slice(0, MAX_TYPES) : [],
    primaryType: str(raw.primaryType, 80),
    businessStatus: status,
    nationalPhoneNumber: str(raw.nationalPhoneNumber, 60),
    websiteUri: str(raw.websiteUri, 500),
    rating: rating !== undefined && rating >= 0 && rating <= 5 ? rating : undefined,
    userRatingCount: count !== undefined && count >= 0 && Number.isInteger(count) ? count : undefined,
    fetchedAt,
  });
}

export interface MappedSearchPage { places: GoogleTransient[]; nextPageToken?: string; dropped: number }

/** A Text Search body. An empty result set legitimately omits `places`. A non-object body is an invalid response (undefined). */
export function mapSearchResponse(body: unknown, fetchedAt: string): MappedSearchPage | undefined {
  if (!isRecord(body)) return undefined;
  const raw = body.places;
  if (raw !== undefined && !Array.isArray(raw)) return undefined;
  const places: GoogleTransient[] = [];
  let dropped = 0;
  for (const p of raw ?? []) { const m = mapPlace(p, fetchedAt); if (m) places.push(m); else dropped++; }
  const token = typeof body.nextPageToken === "string" && body.nextPageToken && body.nextPageToken.length <= MAX_TOKEN ? body.nextPageToken : undefined;
  return { places, nextPageToken: token, dropped };
}

/** A Place Details body. Undefined when it is not a place with a valid id. */
export function mapDetailsResponse(body: unknown, fetchedAt: string): GoogleTransient | undefined {
  return mapPlace(body, fetchedAt);
}
