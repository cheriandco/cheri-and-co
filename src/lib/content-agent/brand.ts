/** Brand facts and tone used by the template generator.
 *  CONFIRMED (owner, 2026-10-29): the "Korean-inspired minimal jewellery" positioning, the audiences, and the
 *  Pinterest-inspired paper packaging. ASSUMED: the tone and palette below, until brand guidelines are supplied
 *  (see docs/BUSINESS_CONTEXT.md). */
import type { Audience } from "@/types/content-agent";

export const BRAND_NAME = "Cheri & Co.";
export const BRAND_SIGNATURE = `Korean-inspired minimal jewellery by ${BRAND_NAME}`;

/** ASSUMED tone: warm, simple, never pushy. Lines contain no product, price or availability claims. */
export const HOOKS: Record<Audience, string> = {
  everyday: "Small details, everyday style.",
  college: "Your college look, made simple.",
  work: "Quietly polished for the workday.",
  gifting: "A gift that feels thoughtfully picked.",
};

/** ASSUMED palette, taken from the dashboard theme. Replace with the client's brand guidelines. */
export const PALETTE_NOTE =
  "ASSUMED: soft ivory, dusty rose and charcoal text. Replace with the client's brand guidelines when supplied.";

export const BASE_HASHTAGS = ["CheriAndCo", "KoreanStyleJewellery", "MinimalJewellery"];

export const AUDIENCE_HASHTAG: Record<Audience, string> = {
  everyday: "EverydayJewellery", college: "CollegeStyle", work: "OfficeStyle", gifting: "JewelleryGifting",
};

export const MAX_CAPTION_LENGTH = 2200;
