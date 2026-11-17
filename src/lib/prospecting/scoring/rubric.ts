/** The 100-point priority rubric (specification section 4.2). Pure and deterministic: the same inputs and configuration give the same result.
 *
 *  PRINCIPLES (all enforced here and by tests):
 *  - The score PRIORITISES; it never qualifies. Nothing in this file can produce a "Qualified" outcome.
 *  - Unknown (U) evidence earns zero points. Nothing is inferred to fill a gap.
 *  - Google cannot see the assortment, so without a person's confirmation category fit is capped at 24 and assortment at 8, which makes
 *    the highest score an unreviewed candidate can reach 77.
 *  - The result holds only numbers and fixed rule codes. No Google text is copied into it (it is class P and may be stored). */
import type { GoogleTransient } from "../transient";
import { hasAnyWord, hasUsableUrl, normaliseText, phoneKey } from "./normalise";
import { RUBRIC_MAX, type CampaignLocation, type CriterionKey, type ScoringConfig, DEFAULT_SCORING_CONFIG } from "./config";

/** V a fact Google returned; I an inference from a type label or a name keyword; VI both; H a person confirmed it; U unknown (zero points). */
export type Grade = "V" | "I" | "VI" | "H" | "U";

export const RULE_CODES = [
  "CAT_HUMAN_CONFIRMED", "CAT_TYPE_AND_NAME_SIGNAL", "CAT_TYPE_ONLY", "CAT_NAME_SIGNAL_GENERIC_STORE", "CAT_NOT_INDICATED", "CAT_NO_DATA",
  "ASSORT_HUMAN_CONFIRMED", "ASSORT_FASHION_SIGNAL", "ASSORT_GIFT_SIGNAL", "ASSORT_UNKNOWN",
  "MODEL_RETAIL_STREET_ADDRESS", "MODEL_RETAIL_THIN_ADDRESS", "MODEL_RESELLER_HUMAN", "MODEL_NOT_INDICATED", "MODEL_NO_DATA",
  "GEO_TARGET_CITY", "GEO_TARGET_STATE", "GEO_EXPANSION_AREA", "GEO_OUTSIDE", "GEO_NO_DATA",
  "ACT_OPERATIONAL", "ACT_RATED", "ACT_WELL_RATED", "ACT_TEMP_CLOSED", "ACT_PERM_CLOSED", "ACT_NEW_VENTURE_HUMAN", "ACT_NO_DATA",
  "CONTACT_PHONE", "CONTACT_WEBSITE", "CONTACT_EVIDENCE_QUALITY", "CONTACT_COMPLETE_ADDRESS", "CONTACT_DETAILS_FRESH",
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export const REVIEW_FLAGS = [
  "POSSIBLE_PRECIOUS_METAL_JEWELLER", "POSSIBLE_MANUFACTURER_OR_WHOLESALER", "REPAIR_ONLY_WORDING", "ONLINE_ONLY_INDICATION",
  "TEMPORARILY_CLOSED", "CATEGORY_INFERENCE_ONLY", "ASSORTMENT_NOT_VERIFIED",
] as const;
export type ReviewFlag = (typeof REVIEW_FLAGS)[number];

/** Facts only a person can add. Each is a plain yes/no recorded by a reviewer, never inferred. */
export interface HumanEvidence {
  /** A person confirmed the shop sells fashion or imitation jewellery or women's accessories. */
  sellsFashionCategory?: boolean;
  /** A person confirmed an everyday, CZ/AD or gifting assortment. Adds up to 17 points. */
  assortmentConfirmed?: boolean;
  /** A person noted this is a new venture (up to 4 points). */
  newVenture?: boolean;
  /** A person found online-reseller evidence for a business with no shop (5 points). */
  resellerEvidence?: boolean;
}

export interface ScoreInput {
  place: GoogleTransient;
  locations: readonly CampaignLocation[];
  human?: HumanEvidence;
  /** True when the details call was made inside the cache window. */
  detailsFresh?: boolean;
}

export interface Criterion { points: number; max: number; grade: Grade; codes: RuleCode[] }

export interface GeographyFacts {
  /** Address components name a state and it matches no configured location's state, nor does the city: a verified fact. */
  outside: boolean;
  cityKnown: boolean;
  stateKnown: boolean;
}

export interface ScoreResult {
  configVersion: string;
  total: number;
  band: "high" | "medium" | "low";
  criteria: Record<CriterionKey, Criterion>;
  flags: ReviewFlag[];
  /** Criteria whose evidence is unknown (they earned nothing). */
  unknowns: CriterionKey[];
  geography: GeographyFacts;
  /** Yes/no facts only; never the values. */
  contactFlags: { hasPhone: boolean; hasWebsite: boolean; completeAddress: boolean; detailsFresh: boolean };
  businessStatus: "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY" | "UNKNOWN";
}

const typeSet = (p: GoogleTransient): Set<string> => new Set([p.primaryType, ...p.types].filter((t): t is string => !!t));
const anyIn = (set: Set<string>, list: readonly string[]) => list.some((t) => set.has(t));
const component = (p: GoogleTransient, types: readonly string[]) => p.addressComponents?.filter((c) => c.types.some((t) => types.includes(t))) ?? [];
const texts = (cs: ReturnType<typeof component>) => cs.flatMap((c) => [normaliseText(c.longText), normaliseText(c.shortText)]).filter(Boolean);

export function bandFor(total: number, cfg: ScoringConfig): ScoreResult["band"] {
  return total >= cfg.bands.high ? "high" : total >= cfg.bands.medium ? "medium" : "low";
}

/** Verified location facts from the address components. Absent components mean unknown, never "outside". */
export function geographyFacts(place: GoogleTransient, locations: readonly CampaignLocation[], cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): GeographyFacts & { cityTarget: boolean; cityExpansion: boolean; stateMatch: boolean } {
  const cities = texts(component(place, cfg.cityComponentTypes));
  const states = texts(component(place, cfg.stateComponentTypes));
  const cityIs = (kind: CampaignLocation["kind"]) => locations.some((l) => l.kind === kind && cities.includes(normaliseText(l.city)));
  const cityTarget = cityIs("target");
  const cityExpansion = cityIs("expansion");
  // Six points are for the state of a TARGET city; an expansion city's own state does not earn them (it earns the three expansion points).
  const stateMatch = locations.some((l) => l.kind === "target" && states.includes(normaliseText(l.state)));
  const stateAny = locations.some((l) => states.includes(normaliseText(l.state)));
  // "Outside" is a verified fact only when a state is named and neither it nor the city matches ANY configured location.
  const outside = states.length > 0 && !stateAny && !cityTarget && !cityExpansion && locations.length > 0;
  return { outside, cityKnown: cities.length > 0, stateKnown: states.length > 0, cityTarget, cityExpansion, stateMatch };
}

export function scorePlace(input: ScoreInput, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): ScoreResult {
  const { place, locations } = input;
  const human = input.human ?? {};
  const types = typeSet(place);
  const name = place.displayName;

  const relevantType = anyIn(types, cfg.relevantTypes);
  const giftType = anyIn(types, cfg.giftTypes);
  const genericStore = anyIn(types, cfg.genericStoreTypes);
  const retailType = relevantType || genericStore;
  const catSignal = hasAnyWord(name, cfg.categorySignalWords);
  const giftSignal = hasAnyWord(name, cfg.giftSignalWords);
  const street = component(place, cfg.streetComponentTypes).length > 0;
  const geo = geographyFacts(place, locations, cfg);
  const phone = phoneKey(place.nationalPhoneNumber) !== undefined;
  const website = hasUsableUrl(place.websiteUri);
  const typesKnown = types.size > 0;
  const addressKnown = !!place.formattedAddress || (place.addressComponents?.length ?? 0) > 0;

  // 1. Product-category fit (30; automation cap 24)
  const category: Criterion = { points: 0, max: RUBRIC_MAX.category, grade: "U", codes: [] };
  if (human.sellsFashionCategory === true) { category.points = 30; category.grade = "H"; category.codes = ["CAT_HUMAN_CONFIRMED"]; }
  else if (relevantType && catSignal) { category.points = Math.min(24, cfg.automationCaps.category); category.grade = "VI"; category.codes = ["CAT_TYPE_AND_NAME_SIGNAL"]; }
  else if (relevantType) { category.points = Math.min(16, cfg.automationCaps.category); category.grade = "I"; category.codes = ["CAT_TYPE_ONLY"]; }
  else if (catSignal && genericStore) { category.points = Math.min(8, cfg.automationCaps.category); category.grade = "I"; category.codes = ["CAT_NAME_SIGNAL_GENERIC_STORE"]; }
  else if (typesKnown) { category.grade = "V"; category.codes = ["CAT_NOT_INDICATED"]; }
  else { category.codes = ["CAT_NO_DATA"]; }

  // 2. Assortment compatibility (25; automation cap 8; the other 17 only from a person)
  const assortment: Criterion = { points: 0, max: RUBRIC_MAX.assortment, grade: "U", codes: [] };
  let base = 0;
  if (relevantType && catSignal) { base = Math.min(8, cfg.automationCaps.assortment); assortment.codes.push("ASSORT_FASHION_SIGNAL"); assortment.grade = "I"; }
  else if ((giftType || giftSignal) && retailType) { base = Math.min(4, cfg.automationCaps.assortment); assortment.codes.push("ASSORT_GIFT_SIGNAL"); assortment.grade = "I"; }
  assortment.points = base;
  if (human.assortmentConfirmed === true) { assortment.points = Math.min(RUBRIC_MAX.assortment, base + 17); assortment.grade = "H"; assortment.codes = ["ASSORT_HUMAN_CONFIRMED"]; }
  else if (base === 0) assortment.codes = ["ASSORT_UNKNOWN"];

  // 3. Business-model fit (15)
  const businessModel: Criterion = { points: 0, max: RUBRIC_MAX.businessModel, grade: "U", codes: [] };
  if (retailType && street) { businessModel.points = 15; businessModel.grade = "V"; businessModel.codes = ["MODEL_RETAIL_STREET_ADDRESS"]; }
  else if (retailType) { businessModel.points = 10; businessModel.grade = "V"; businessModel.codes = ["MODEL_RETAIL_THIN_ADDRESS"]; }
  else if (human.resellerEvidence === true) { businessModel.points = 5; businessModel.grade = "H"; businessModel.codes = ["MODEL_RESELLER_HUMAN"]; }
  else if (typesKnown || addressKnown) { businessModel.grade = "V"; businessModel.codes = ["MODEL_NOT_INDICATED"]; }
  else businessModel.codes = ["MODEL_NO_DATA"];

  // 4. Geographic fit (10)
  const geography: Criterion = { points: 0, max: RUBRIC_MAX.geography, grade: "U", codes: [] };
  if (geo.cityTarget) { geography.points = 10; geography.codes = ["GEO_TARGET_CITY"]; geography.grade = "V"; }
  else if (geo.stateMatch) { geography.points = 6; geography.codes = ["GEO_TARGET_STATE"]; geography.grade = "V"; }
  else if (geo.cityExpansion) { geography.points = 3; geography.codes = ["GEO_EXPANSION_AREA"]; geography.grade = "V"; }
  else if (geo.cityKnown || geo.stateKnown) { geography.grade = "V"; geography.codes = ["GEO_OUTSIDE"]; }
  else geography.codes = ["GEO_NO_DATA"];

  // 5. Business activity (10)
  const activity: Criterion = { points: 0, max: RUBRIC_MAX.activity, grade: "U", codes: [] };
  const count = place.userRatingCount ?? 0;
  if (place.businessStatus === "OPERATIONAL") {
    activity.points = 6; activity.grade = "V"; activity.codes = ["ACT_OPERATIONAL"];
    if (count >= cfg.ratingCount.some) { activity.points += 2; activity.codes.push("ACT_RATED"); }
    if (count >= cfg.ratingCount.many) { activity.points += 4; activity.codes.push("ACT_WELL_RATED"); }
  } else if (place.businessStatus === "CLOSED_TEMPORARILY") { activity.grade = "V"; activity.codes = ["ACT_TEMP_CLOSED"]; }
  else if (place.businessStatus === "CLOSED_PERMANENTLY") { activity.grade = "V"; activity.codes = ["ACT_PERM_CLOSED"]; }
  else activity.codes = ["ACT_NO_DATA"];
  if (human.newVenture === true) { activity.points += 4; activity.grade = "H"; activity.codes.push("ACT_NEW_VENTURE_HUMAN"); }
  activity.points = Math.min(RUBRIC_MAX.activity, activity.points);

  // 6. Contactability and evidence quality (10), computed last because one point depends on the other five
  const contactability: Criterion = { points: 0, max: RUBRIC_MAX.contactability, grade: "U", codes: [] };
  const evidenced = [category, assortment, businessModel, geography, activity].filter((c) => c.points > 0 && (c.grade === "V" || c.grade === "VI" || c.grade === "H")).length;
  const completeAddress = street && geo.cityKnown && geo.stateKnown;
  const detailsFresh = input.detailsFresh === true;
  if (phone) { contactability.points += 4; contactability.codes.push("CONTACT_PHONE"); }
  if (website) { contactability.points += 2; contactability.codes.push("CONTACT_WEBSITE"); }
  if (evidenced >= cfg.evidenceQualityThreshold) { contactability.points += 2; contactability.codes.push("CONTACT_EVIDENCE_QUALITY"); }
  if (completeAddress) { contactability.points += 1; contactability.codes.push("CONTACT_COMPLETE_ADDRESS"); }
  if (detailsFresh) { contactability.points += 1; contactability.codes.push("CONTACT_DETAILS_FRESH"); }
  if (phone || website || addressKnown) contactability.grade = "V";

  const criteria = { category, assortment, businessModel, geography, activity, contactability };
  const total = Object.values(criteria).reduce((s, c) => s + c.points, 0);
  const unknowns = (Object.keys(criteria) as CriterionKey[]).filter((k) => criteria[k].grade === "U");

  // Review flags: shown to the reviewer, never decisive.
  const flags: ReviewFlag[] = [];
  if (types.has("jewelry_store") && hasAnyWord(name, cfg.preciousMetalWords) && !catSignal) flags.push("POSSIBLE_PRECIOUS_METAL_JEWELLER");
  if (hasAnyWord(name, cfg.manufacturerWords)) flags.push("POSSIBLE_MANUFACTURER_OR_WHOLESALER");
  if (hasAnyWord(name, cfg.repairWords)) flags.push("REPAIR_ONLY_WORDING");
  if (hasAnyWord(name, cfg.onlineWords)) flags.push("ONLINE_ONLY_INDICATION");
  if (place.businessStatus === "CLOSED_TEMPORARILY") flags.push("TEMPORARILY_CLOSED");
  if (category.grade === "I" || category.grade === "VI") flags.push("CATEGORY_INFERENCE_ONLY");
  if (human.assortmentConfirmed !== true) flags.push("ASSORTMENT_NOT_VERIFIED");

  return {
    configVersion: cfg.version, total, band: bandFor(total, cfg), criteria, flags, unknowns,
    geography: { outside: geo.outside, cityKnown: geo.cityKnown, stateKnown: geo.stateKnown },
    contactFlags: { hasPhone: phone, hasWebsite: website, completeAddress, detailsFresh },
    businessStatus: place.businessStatus ?? "UNKNOWN",
  };
}

/** Name present but nothing else is not enough; kept here so tests and callers share one definition of "evidence". */
export const criteriaWithEvidence = (r: ScoreResult): number => (Object.values(r.criteria) as Criterion[]).filter((c) => c.grade !== "U").length;
