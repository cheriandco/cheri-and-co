/** Versioned, editable scoring configuration (specification section 4). Weights are fixed by the approved rubric; word lists, type lists
 *  and bands are configuration. Every score stores the `version` it was computed with.
 *
 *  Place-type names follow Google's published type vocabulary from memory (UNVERIFIED until the Phase 8 contract check); an unrecognised or
 *  missing type simply earns nothing. Signal words are inferences (grade I), never conclusions. */

export type CriterionKey = "category" | "assortment" | "businessModel" | "geography" | "activity" | "contactability";

/** The maximum points per criterion (sum 100). */
export const RUBRIC_MAX: Readonly<Record<CriterionKey, number>> = { category: 30, assortment: 25, businessModel: 15, geography: 10, activity: 10, contactability: 10 };

export interface CampaignLocation { city: string; state: string; kind: "target" | "expansion" }

export interface ScoringConfig {
  version: string;
  /** Automation can never award more than this without a person's confirmation (the "77 ceiling"). */
  automationCaps: { category: number; assortment: number };
  bands: { high: number; medium: number };
  /** Fewer criteria than this with ANY evidence => "Insufficient Information". */
  minCriteriaWithEvidence: number;
  /** At least this many of the five other criteria must rest on V/H evidence for the evidence-quality point. */
  evidenceQualityThreshold: number;
  ratingCount: { some: number; many: number };
  /** Words about fashion jewellery or accessories in a business name (category fit and assortment). */
  categorySignalWords: readonly string[];
  /** Gifting words; they support assortment only, never category fit. */
  giftSignalWords: readonly string[];
  relevantTypes: readonly string[];
  giftTypes: readonly string[];
  genericStoreTypes: readonly string[];
  /** Review-flag word lists (flags route to a person; they never decide anything). */
  preciousMetalWords: readonly string[];
  manufacturerWords: readonly string[];
  repairWords: readonly string[];
  onlineWords: readonly string[];
  streetComponentTypes: readonly string[];
  cityComponentTypes: readonly string[];
  stateComponentTypes: readonly string[];
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = Object.freeze({
  version: "rubric-2026-11-a",
  automationCaps: { category: 24, assortment: 8 },
  bands: { high: 55, medium: 35 },
  minCriteriaWithEvidence: 3,
  evidenceQualityThreshold: 4,
  ratingCount: { some: 1, many: 10 },
  categorySignalWords: ["imitation", "artificial", "fashion", "fancy", "ladies", "accessories", "novelty", "boutique"],
  giftSignalWords: ["gift", "gifts", "gifting"],
  relevantTypes: ["jewelry_store", "clothing_store", "gift_shop", "cosmetics_store", "beauty_supply_store"],
  giftTypes: ["gift_shop"],
  genericStoreTypes: ["store", "department_store", "home_goods_store", "variety_store"],
  preciousMetalWords: ["gold", "diamond", "diamonds", "bullion", "sona", "swarna", "hallmark", "hallmarked", "platinum"],
  manufacturerWords: ["manufacturer", "manufacturers", "manufacturing", "wholesale", "wholesaler", "wholesalers", "exporter", "exporters", "factory", "distributor", "distributors"],
  repairWords: ["repair", "repairs", "repairing", "polishing", "polish"],
  onlineWords: ["online", "e commerce", "ecommerce"],
  streetComponentTypes: ["route", "street_number", "premise", "subpremise"],
  cityComponentTypes: ["locality", "postal_town", "administrative_area_level_3"],
  stateComponentTypes: ["administrative_area_level_1"],
}) as ScoringConfig;

/** Returns a list of problems; empty means usable. Used when an admin edits the configuration. */
export function validateScoringConfig(c: ScoringConfig): string[] {
  const problems: string[] = [];
  if (!c.version.trim()) problems.push("version is required");
  if (!(c.bands.high > c.bands.medium && c.bands.medium > 0 && c.bands.high <= 100)) problems.push("bands must satisfy 0 < medium < high <= 100");
  if (c.automationCaps.category > RUBRIC_MAX.category || c.automationCaps.category < 0) problems.push("category automation cap out of range");
  if (c.automationCaps.assortment > RUBRIC_MAX.assortment || c.automationCaps.assortment < 0) problems.push("assortment automation cap out of range");
  if (c.minCriteriaWithEvidence < 1 || c.minCriteriaWithEvidence > 6) problems.push("minCriteriaWithEvidence must be 1 to 6");
  if (c.ratingCount.some < 1 || c.ratingCount.many <= c.ratingCount.some) problems.push("rating thresholds must satisfy 1 <= some < many");
  for (const [k, list] of Object.entries({ categorySignalWords: c.categorySignalWords, relevantTypes: c.relevantTypes, streetComponentTypes: c.streetComponentTypes, cityComponentTypes: c.cityComponentTypes, stateComponentTypes: c.stateComponentTypes })) {
    if (!list.length) problems.push(`${k} must not be empty`);
  }
  return problems;
}
