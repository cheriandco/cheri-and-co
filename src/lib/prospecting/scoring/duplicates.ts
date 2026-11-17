/** In-memory duplicate detection (specification section 5.5). Google-side keys (phone, website, name) are compared in memory against
 *  still-fresh cache rows and the CRM; only the RESULT (a rule code and the matched id) is meant to be stored. The Google text itself is
 *  never returned. Pure functions: callers pass in what to compare against. */
import type { GoogleTransient } from "../transient";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./config";
import { normaliseText, phoneKey, websiteDomain } from "./normalise";

export type DuplicateRule = "DUP_PLACE_ID" | "DUP_PHONE" | "DUP_WEBSITE_DOMAIN" | "DUP_NAME_LOCALITY";

/** One thing to compare against: another fresh candidate (`cache`) or an existing retailer (`crm`). Fields are optional; absent never matches. */
export interface KnownBusiness {
  id: string;
  source: "cache" | "crm";
  placeId?: string;
  phone?: string;
  website?: string;
  name?: string;
  locality?: string;
}

export interface DuplicateMatch {
  rule: DuplicateRule;
  matchedId: string;
  source: KnownBusiness["source"];
  /** A person may undo a fuzzy match. An identical Place ID is a key match and is not undoable. */
  undoable: boolean;
}

export function localityOf(place: GoogleTransient, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): string {
  const c = place.addressComponents?.find((x) => x.types.some((t) => cfg.cityComponentTypes.includes(t)));
  return normaliseText(c?.longText ?? c?.shortText);
}

/** First matching rule wins, in this order: Place ID, phone, website domain, name plus locality. A record is never matched with itself. */
export function detectDuplicate(place: GoogleTransient, known: readonly KnownBusiness[], cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): DuplicateMatch | undefined {
  // Convention: a cache entry's id is its own Place ID, so an entry with that id is the candidate itself and is skipped.
  const others = known.filter((k) => !(k.source === "cache" && k.id === place.placeId));
  const byId = others.find((k) => k.placeId !== undefined && k.placeId === place.placeId);
  if (byId) return { rule: "DUP_PLACE_ID", matchedId: byId.id, source: byId.source, undoable: false };

  const phone = phoneKey(place.nationalPhoneNumber);
  if (phone) { const m = others.find((k) => phoneKey(k.phone) === phone); if (m) return { rule: "DUP_PHONE", matchedId: m.id, source: m.source, undoable: true }; }

  const domain = websiteDomain(place.websiteUri);
  if (domain) { const m = others.find((k) => websiteDomain(k.website) === domain); if (m) return { rule: "DUP_WEBSITE_DOMAIN", matchedId: m.id, source: m.source, undoable: true }; }

  const name = normaliseText(place.displayName);
  const locality = localityOf(place, cfg);
  if (name && locality) {
    const m = others.find((k) => normaliseText(k.name) === name && normaliseText(k.locality) === locality);
    if (m) return { rule: "DUP_NAME_LOCALITY", matchedId: m.id, source: m.source, undoable: true };
  }
  return undefined;
}
