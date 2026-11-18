/** Brand Brain: the approved brand information the Content Studio may use. Nothing here is invented.
 *  Every fact is tagged "confirmed" (stated by the owner, docs/BUSINESS_CONTEXT.md §1, 2026-10-29) or "assumed" (a style preference we chose until the
 *  owner supplies brand guidelines, §3). Only facts marked `inCopy` are sent to the AI model; only "confirmed" facts are ever described to it as facts.
 *  It holds no product material wording, price, offer, certification or claim: those must come from the product record. It is read-only code on purpose:
 *  a stored, editable Brand Brain needs a table, which needs an approved migration. */
import type { Audience } from "@/types/content-agent";

export type BrandStatus = "confirmed" | "assumed";
export interface BrandFact { id: string; label: string; text: string; status: BrandStatus; inCopy: boolean }

export const BRAND_NAME = "Cheri & Co.";

export const BRAND_FACTS: BrandFact[] = [
  { id: "positioning", label: "Positioning", status: "confirmed", inCopy: true, text: "Korean-inspired minimal jewellery and everyday fashion accessories, affordable but premium-looking, for everyday wear and gifting." },
  { id: "categories", label: "Categories", status: "confirmed", inCopy: true, text: "Bracelets, chain pendants, earrings, chains, rings, hair accessories and watch combos." },
  { id: "formats", label: "Formats", status: "confirmed", inCopy: false, text: "Sold as single pieces and as combo packs of 2, 3, 6 and 10 pieces. Pack contents are described only from the product record." },
  { id: "audience", label: "Audience", status: "confirmed", inCopy: true, text: "College-going girls, working professionals and people buying a gift on a budget, across India." },
  { id: "curation", label: "Curation", status: "confirmed", inCopy: false, text: "Curated concepts that stay in trend; not fast fashion." },
  { id: "packaging", label: "Packaging", status: "confirmed", inCopy: false, text: "Pinterest-inspired paper packaging for packs. Not mentioned in copy unless the product record says so." },
  { id: "voice", label: "Voice", status: "assumed", inCopy: true, text: "Warm, simple and quietly polished; never pushy. Indian English spelling. No emojis." },
];

/** Things the Studio never writes, whatever the brief says. Mirrors the claim guard (src/lib/content-agent/claims.ts). */
export const BRAND_NEVER: string[] = [
  "Prices, discounts, offers, free delivery or shipping promises",
  "Stock levels or scarcity (only a few left, selling fast, limited)",
  "Materials, plating, durability, water or tarnish resistance, skin safety, certifications, health effects or superlatives, unless the product record carries that exact wording",
  "Specifications, ingredients, sizes or contents that the product record does not state",
  "Links, handles, phone numbers, emails or any person's name",
];

export const BRAND_SIGNATURE = `Korean-inspired minimal jewellery by ${BRAND_NAME}`;
export const BASE_TAGS = ["#CheriAndCo", "#KoreanStyleJewellery", "#MinimalJewellery"];
export const AUDIENCE_TAG: Record<Audience, string> = { everyday: "#EverydayJewellery", college: "#CollegeStyle", work: "#OfficeStyle", gifting: "#JewelleryGifting" };

/** What the model is told about the brand. Confirmed facts are facts; the assumed voice is style guidance only. */
export function brandForPrompt(): { name: string; facts: string[]; style_guidance: string[]; never: string[] } {
  return {
    name: BRAND_NAME,
    facts: BRAND_FACTS.filter((f) => f.inCopy && f.status === "confirmed").map((f) => f.text),
    style_guidance: BRAND_FACTS.filter((f) => f.inCopy && f.status === "assumed").map((f) => f.text),
    never: BRAND_NEVER,
  };
}
