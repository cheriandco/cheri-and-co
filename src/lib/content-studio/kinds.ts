/** The five kinds of copy the Content Studio drafts, and where each is stored (existing content_items.platform values; no migration). */
import type { ContentPlatform } from "@/types/social";

export const STUDIO_KINDS = ["instagram_caption", "facebook_post", "linkedin_post", "product_description", "campaign_copy"] as const;
export type StudioKind = (typeof STUDIO_KINDS)[number];
export const isStudioKind = (v: unknown): v is StudioKind => typeof v === "string" && (STUDIO_KINDS as readonly string[]).includes(v);

export interface KindMeta {
  label: string;
  platform: ContentPlatform;
  /** Allowed length of the AI-written body, in characters. */
  body: readonly [number, number];
  /** One line of kind-specific guidance for the model. */
  guidance: string;
  /** Plain note shown in the UI about where the draft is saved. */
  savedAs: string;
}

export const KIND_META: Record<StudioKind, KindMeta> = {
  instagram_caption: { label: "Instagram caption", platform: "Instagram", body: [20, 900], savedAs: "Instagram draft", guidance: "An Instagram caption: one to three short paragraphs, warm and visual. Hashtags are added separately." },
  facebook_post: { label: "Facebook post", platform: "Facebook", body: [20, 1200], savedAs: "Facebook draft", guidance: "A Facebook post: friendly and conversational, two to four short sentences or two short paragraphs." },
  linkedin_post: { label: "LinkedIn post", platform: "LinkedIn", body: [40, 1300], savedAs: "LinkedIn draft", guidance: "A LinkedIn post: professional and brief, about the brand and the piece, with no hype. Two short paragraphs at most." },
  product_description: { label: "Product description", platform: "Amazon A+", body: [30, 800], savedAs: "Amazon A+ draft (product description)", guidance: "A product description for a listing or product page: plain, factual sentences built only from the product record. Do not add features." },
  campaign_copy: { label: "Campaign copy", platform: "Email", body: [40, 1200], savedAs: "Email draft (campaign copy)", guidance: "Marketing campaign copy: a short headline and a body of two short paragraphs for an email or ad. No offers or deadlines." },
};
