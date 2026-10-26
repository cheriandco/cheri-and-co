import type { CatalogueProduct, ExtractedPreferences, RecommendedProduct } from "@/types/b2c-agent";

export const MIN_MATCH_SCORE = 40;

export const formatSamplePrice = (n: number | undefined) =>
  n == null ? "Price not available in the sample catalogue" : `₹${n.toLocaleString("en-IN")} (sample price, not a live price)`;

/**
 * Explicit criteria (hard filters first, then points):
 *  - category: hard filter when stated, +40
 *  - budget: hard filter on price; products without a sample price are excluded when a budget is stated, +15
 *  - occasion +25, style +20, material +10 (soft)
 * A product needs at least one soft or hard criterion to match and a total >= MIN_MATCH_SCORE.
 */
export const hasSearchCriteria = (prefs: ExtractedPreferences) =>
  Boolean(prefs.category || prefs.style || prefs.occasion || prefs.material || prefs.budgetMaxInr != null || prefs.budgetMinInr != null);

export function searchCatalogue(prefs: ExtractedPreferences, catalogue: CatalogueProduct[], limit = 3): RecommendedProduct[] {
  if (!hasSearchCriteria(prefs)) return [];
  const out: RecommendedProduct[] = [];
  for (const p of catalogue) {
    const reasons: string[] = [];
    let score = 0;
    if (prefs.category) {
      if (p.category !== prefs.category) continue;
      score += 40;
      reasons.push(`Category matches: ${p.category}`);
    }
    if (p.samplePriceInr != null) {
      if (prefs.budgetMaxInr != null && p.samplePriceInr > prefs.budgetMaxInr) continue;
      if (prefs.budgetMinInr != null && p.samplePriceInr < prefs.budgetMinInr) continue;
      if (prefs.budgetMaxInr != null || prefs.budgetMinInr != null) {
        score += 15;
        reasons.push("Sample price is within the stated budget");
      }
    } else if (prefs.budgetMaxInr != null || prefs.budgetMinInr != null) {
      continue; // can't claim a match to a budget when the catalogue has no price
    }
    if (prefs.occasion && p.occasions.includes(prefs.occasion)) {
      score += 25;
      reasons.push(`Listed for ${prefs.occasion} occasions`);
    }
    if (prefs.style && p.style === prefs.style) {
      score += 20;
      reasons.push(`Style matches: ${p.style}`);
    }
    if (prefs.material && p.material?.toLowerCase().includes(prefs.material)) {
      score += 10;
      reasons.push(`Material mentions ${prefs.material}`);
    }
    if (score < MIN_MATCH_SCORE) continue;
    out.push({
      productId: p.id, name: p.name, category: p.category, matchScore: Math.min(100, score), matchReasons: reasons,
      samplePriceInr: p.samplePriceInr ?? null, priceLabel: formatSamplePrice(p.samplePriceInr),
    });
  }
  return out.sort((a, b) => b.matchScore - a.matchScore || (a.samplePriceInr ?? Infinity) - (b.samplePriceInr ?? Infinity) || a.productId.localeCompare(b.productId)).slice(0, limit);
}
