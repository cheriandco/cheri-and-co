import type { CatalogueProduct, ExtractedPreferences, JewelleryCategory, JewelleryOccasion, JewelleryStyle } from "@/types/b2c-agent";
import { normalise } from "./intent";

const CATEGORY: [JewelleryCategory, RegExp][] = [
  ["set", /\b(sets?|combo)\b/],
  ["earrings", /\b(ear ?rings?|studs?|hoops?|jhumkas?)\b/],
  ["necklace", /\b(necklaces?|pendants?|chains?|chokers?)\b/],
  ["bracelet", /\b(bracelets?|bangles?|kadas?)\b/],
  ["anklet", /\b(anklets?|payals?)\b/],
  ["ring", /\brings?\b/],
];
const STYLE: [JewelleryStyle, RegExp][] = [
  ["minimal", /\b(minimal\w*|simple|subtle|dainty|understated)\b/],
  ["traditional", /\b(traditional|ethnic|desi)\b/],
  ["statement", /\b(statement|bold|heavy|chunky)\b/],
  ["classic", /\b(classic|elegant|timeless)\b/],
  ["boho", /\b(boho|bohemian|quirky)\b/],
];
const OCCASION: [JewelleryOccasion, RegExp][] = [
  ["wedding", /\b(wedding|bridal|bride|shaadi|engagement|reception)\b/],
  ["festive", /\b(festive|festival|diwali|navratri|eid|puja|karwa chauth)\b/],
  ["party", /\b(party|cocktail|night out|club)\b/],
  ["office", /\b(office|work|formal|professional)\b/],
  ["daily", /\b(daily|everyday|regular|casual)\b/],
  ["gift", /\b(gift|birthday|anniversary|present|surprise)\b/],
];
const MATERIAL = /\b(rose gold|gold|silver|pearls?|kundan|oxidi[sz]ed|diamond|cubic zirconia|brass)\b/;
const MISSING_ATTR = /\b(size|sizes|weight|dimensions?|length|carat|purity|hallmark\w*|warranty|certificate\w*|care|tarnish\w*|fad(?:e|es|ing)|rust\w*|discolou?r\w*|waterproof|hypoallergenic|nickel|allerg\w+|skin)\b/g;

/** "Is it real gold?" asks about material authenticity, which the catalogue never states. */
const AUTHENTICITY = /\b(real|genuine|authentic|pure|solid|original)\b.{0,12}\b(gold|silver|diamonds?|pearls?)\b|\b(gold|silver) plated\b/;

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").toLowerCase();
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*(k)?$/);
  if (!m) return NaN;
  return Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1));
}
const AMT = "(?:₹|rs\\.?|inr)?\\s*(\\d[\\d,]*(?:\\.\\d+)?\\s*k?)";

export function extractBudget(text: string): { min?: number; max?: number } {
  const between = text.match(new RegExp(`(?:between|from)\\s*${AMT}\\s*(?:and|to|-)\\s*${AMT}`));
  if (between) {
    const a = parseAmount(between[1].replace(/\s/g, "")), b = parseAmount(between[2].replace(/\s/g, ""));
    if (Number.isFinite(a) && Number.isFinite(b)) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const upper = text.match(new RegExp(`(?:under|below|less than|up to|upto|within|max(?:imum)?|not more than|budget(?: is| of)?|around|about)\\s*${AMT}`));
  if (upper) {
    const v = parseAmount(upper[1].replace(/\s/g, ""));
    if (Number.isFinite(v)) return { max: v };
  }
  const symbol = text.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?\s*k?)/);
  if (symbol) {
    const v = parseAmount(symbol[1].replace(/\s/g, ""));
    if (Number.isFinite(v)) return { max: v };
  }
  return {};
}

/** Product explicitly referenced by id, or by name (all significant name words present). */
export function findReferencedProduct(text: string, catalogue: CatalogueProduct[]): CatalogueProduct | undefined {
  const compact = text.replace(/\s/g, "");
  const byId = catalogue.find((p) => compact.includes(p.id.toLowerCase().replace(/\s/g, "")));
  if (byId) return byId;
  const generic = new Set(["and", "the", "set", "pair"]);
  let best: { p: CatalogueProduct; score: number } | undefined;
  for (const p of catalogue) {
    const words = normalise(p.name).split(" ").filter((w) => w.length > 2 && !generic.has(w));
    const hits = words.filter((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}s?\\b`).test(text)).length;
    // Need every distinguishing word, and at least two of them (a lone category word is not a reference).
    if (words.length >= 2 && hits === words.length && (!best || hits > best.score)) best = { p, score: hits };
  }
  return best?.p;
}

export function extractPreferences(enquiry: string, catalogue: CatalogueProduct[]): ExtractedPreferences {
  const text = normalise(enquiry);
  const budget = extractBudget(text);
  const product = findReferencedProduct(text, catalogue);
  const prefs: ExtractedPreferences = { requestedMissingAttributes: [] };
  const category = CATEGORY.find(([, re]) => re.test(text))?.[0];
  const style = STYLE.find(([, re]) => re.test(text))?.[0];
  const occasion = OCCASION.find(([, re]) => re.test(text))?.[0];
  const material = text.match(MATERIAL)?.[1];
  if (category) prefs.category = category;
  if (style) prefs.style = style;
  if (occasion) prefs.occasion = occasion;
  if (material) prefs.material = material;
  if (budget.min != null) prefs.budgetMinInr = budget.min;
  if (budget.max != null) prefs.budgetMaxInr = budget.max;
  if (product) {
    prefs.productId = product.id;
    prefs.category ??= product.category;
  }
  const missing: string[] = text.match(MISSING_ATTR) ?? [];
  const careIdx = missing.findIndex((m) => /^(tarnish|fad|rust|discolo)/.test(m));
  if (careIdx >= 0) { missing.splice(careIdx, 1); missing.push("tarnish / colour-fade resistance"); }
  if (AUTHENTICITY.test(text)) missing.push("material authenticity");
  prefs.requestedMissingAttributes = [...new Set(missing)];
  return prefs;
}
