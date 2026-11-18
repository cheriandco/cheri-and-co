/** Deterministic enquiry analysis and product matching over the organisation's REAL catalogue records. Pure: no I/O, no AI, no randomness.
 *  Every recommendation names the catalogue fields it matched on and carries only values from the record: nothing is invented, and a
 *  price, stock figure or status is reported as recorded (or null). Archived products are never recommended. */
import { classifyIntent, normalise } from "@/lib/b2c-agent/intent";
import { CATEGORY, OCCASION, STYLE, extractBudget } from "@/lib/b2c-agent/preferences";
import { contentCategoryFor } from "@/lib/content-agent/live-source";
import type { Product } from "@/types";
import type { EnquiryContext, EnquiryScenario, ProductRecommendation } from "@/types/enquiry";

/** Intents a person must handle: no AI, no sales draft, only a holding reply. */
const HUMAN_INTENTS: Record<string, string> = {
  complaint: "A complaint needs a team member's personal attention.",
  return_refund: "Return and refund eligibility depends on the order and policy; a person decides.",
  order_status: "Order status must be checked against the real order by a person.",
};

const STOP = new Set(("a an and are as at be but by can could do does for from get got had has have how i if in is it its me my of on or our please pls so some that the their them there these they this to us was we what when where which will with would you your hi hello hey thanks thank want need looking like any " +
  "jewellery jewelry piece pieces pair item items product products cheri co tell more about show see know").split(" "));

/** Lower-case words of 3+ letters, minus filler, with a plain trailing "s" removed ("hoops" -> "hoop"). */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const w of normalise(text).split(" ")) {
    const t = w.replace(/[^a-z0-9]/g, "");
    if (t.length < 3 || STOP.has(t)) continue;
    out.add(t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
  }
  return [...out];
}

const COMPARISON = /\b(compare|comparison|versus|vs|differences? between|which (one )?(is|are) (better|best|nicer)|better than|which (one )?should i (pick|choose|get|buy))\b/;
const PURCHASE_INTENT = /\b(i ?'?ll (take|buy|order|go for)|i (want|would like|wish|wanna) to (buy|order|purchase)|i ?'?d like to (buy|order|purchase)|ready to (buy|order|purchase)|place (an |my )?order|how (do|can|should) i (buy|order|pay|purchase)|where (can|do) i (pay|buy|order)|book (it|this|one)|confirm (my|the) order)\b/;

/** The conversation type. Comparison and purchase-intent are detected from the wording; a person-only intent always wins. */
export function scenarioFor(norm: string, needsHuman: boolean, hasCategoryOrProduct: boolean): EnquiryScenario {
  if (needsHuman) return "needs_human";
  if (PURCHASE_INTENT.test(norm)) return "purchase_intent";
  if (COMPARISON.test(norm)) return "comparison";
  return hasCategoryOrProduct ? "product_enquiry" : "general";
}

export interface EnquiryAnalysis { context: EnquiryContext; budgetMax: number | null; budgetMin: number | null }

/** Intent, handover flag and a short list of closed-vocabulary keywords. No free text is kept, so nothing the customer typed can leak from here. */
export function analyseEnquiry(text: string): EnquiryAnalysis {
  const norm = normalise(text);
  const { intent, confidence } = classifyIntent(text);
  const budget = extractBudget(norm);
  const keywords: string[] = [];
  const category = CATEGORY.find(([, re]) => re.test(norm))?.[0];
  const style = STYLE.find(([, re]) => re.test(norm))?.[0];
  const occasion = OCCASION.find(([, re]) => re.test(norm))?.[0];
  if (category) keywords.push(category);
  if (style) keywords.push(style);
  if (occasion) keywords.push(`${occasion} occasion`);
  if (budget.max != null) keywords.push(`budget up to ${budget.max}`);
  if (budget.min != null) keywords.push(`budget from ${budget.min}`);
  const humanReason = HUMAN_INTENTS[intent];
  const scenario = scenarioFor(norm, !!humanReason, !!(category || style || occasion) || intent === "product_details" || intent === "product_recommendation" || intent === "occasion_style_recommendation");
  if (scenario === "comparison") keywords.push("comparison");
  if (scenario === "purchase_intent") keywords.push("ready to buy");
  return {
    context: { scenario, intent, intentConfidence: confidence, needsHuman: !!humanReason, ...(humanReason ? { humanReason } : {}), keywords },
    budgetMin: budget.min ?? null, budgetMax: budget.max ?? null,
  };
}

export const MIN_SCORE = 30;

/** What the owner has not yet recorded for this product. A draft never fills these in; the person reviewing sees the list. */
export function catalogueGaps(p: Product): string[] {
  const gaps: string[] = [];
  if (!(p.description ?? "").trim()) gaps.push("no description recorded");
  if (!p.imageUrl) gaps.push("no image recorded");
  if (!(p.category ?? "").trim()) gaps.push("no category recorded");
  if (p.price === null) gaps.push("no price recorded");
  if (p.stock === null) gaps.push("no stock level recorded");
  return gaps;
}

/** Plain-language notes for the reviewer: what the catalogue could not support. Empty when everything needed is on record. */
export function catalogueNotes(recs: ProductRecommendation[], scenario: EnquiryScenario): string[] {
  const notes: string[] = [];
  if (!recs.length) notes.push("No catalogue product matched this enquiry, so the draft asks the customer a clarifying question.");
  if (scenario === "comparison" && recs.length === 1) notes.push("Only one catalogue product matched, so there is nothing to compare yet.");
  for (const r of recs) {
    const needed = r.catalogueGaps.filter((g) => g !== "no price recorded" && g !== "no stock level recorded");
    if (needed.length) notes.push(`${r.name}: ${needed.join(", ")}. The draft uses only what is recorded.`);
  }
  return notes;
}

export interface RecommendOptions { limit?: number; pinnedProductId?: string | null }

const firstSentence = (s: string | null, max = 160): string | null => {
  const t = (s ?? "").trim().split(/(?<=[.!?])\s+/)[0]?.trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t) : null;
};

/** Ranks real catalogue products for an enquiry. Hard exclusions: archived, known zero stock (unless asked for by name or SKU), a price above
 *  a stated budget, or no recorded price when a budget is stated. Score: SKU or pinned product, then name words, category, description words. */
export function recommendProducts(text: string, products: Product[], opts: RecommendOptions = {}): ProductRecommendation[] {
  const { budgetMax, budgetMin } = analyseEnquiry(text);
  const norm = normalise(text);
  const compact = norm.replace(/[^a-z0-9]/g, ""); // for SKU matching: "rng 001", "RNG-001" and "rng001" are the same
  const enquiryTerms = new Set(terms(text));
  const enquiryCategory = contentCategoryFor(text);
  const out: ProductRecommendation[] = [];

  for (const p of products) {
    if (p.status === "archived") continue;
    const reasons: string[] = [];
    const matchedOn = new Set<"name" | "category" | "description">();
    let score = 0;
    let explicit = false;

    if (opts.pinnedProductId && p.id === opts.pinnedProductId) { score += 100; explicit = true; reasons.push("This enquiry is linked to this product"); }
    const skuKey = (p.sku ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (skuKey.length >= 3 && compact.includes(skuKey)) { score += 100; explicit = true; matchedOn.add("name"); reasons.push(`The enquiry mentions SKU ${p.sku}`); }

    const nameTerms = terms(p.name);
    const nameHits = nameTerms.filter((t) => enquiryTerms.has(t));
    if (nameHits.length) {
      score += Math.min(60, nameHits.length * 30);
      matchedOn.add("name");
      reasons.push(`Name matches: ${nameHits.join(", ")}`);
      if (nameTerms.length >= 2 && nameHits.length === nameTerms.length) explicit = true;
    }

    const productCategory = contentCategoryFor(`${p.category} ${p.name}`);
    if (enquiryCategory && productCategory === enquiryCategory) { score += 40; matchedOn.add("category"); reasons.push(`Category matches: ${p.category || enquiryCategory}`); }
    else {
      const catHits = terms(p.category).filter((t) => enquiryTerms.has(t));
      if (catHits.length) { score += 15; matchedOn.add("category"); reasons.push(`Category word in the enquiry: ${catHits.join(", ")}`); }
    }

    const descHits = terms(p.description ?? "").filter((t) => enquiryTerms.has(t) && !nameTerms.includes(t));
    if (descHits.length) { score += Math.min(30, descHits.length * 10); matchedOn.add("description"); reasons.push(`Description mentions: ${descHits.slice(0, 4).join(", ")}`); }

    if (p.stock === 0 && !explicit) continue; // known to be out of stock: not offered unprompted
    if (budgetMax != null || budgetMin != null) {
      if (p.price === null) continue; // a budget cannot be matched without a recorded price
      if ((budgetMax != null && p.price > budgetMax) || (budgetMin != null && p.price < budgetMin)) continue;
      score += 15; reasons.push("The recorded price is within the stated budget");
    }
    if (p.status === "draft") { score -= 15; reasons.push("Not yet active in the catalogue"); }
    if (p.stock === 0) reasons.push("Recorded stock is 0");
    if (p.status === "low_stock") reasons.push("Recorded as low stock");

    if (score < MIN_SCORE) continue;
    out.push({ productId: p.id, name: p.name, category: p.category, price: p.price, stock: p.stock, status: p.status, score: Math.min(200, score), reasons, matchedOn: [...matchedOn], description: p.description ?? null, imageUrl: p.imageUrl ?? null, catalogueGaps: catalogueGaps(p) });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId)).slice(0, opts.limit ?? 3);
}

export { firstSentence };
