/** Maps a live organisation's catalogue rows to the content agent's input shape.
 *  The database stores no style tags, material wording, approved claims or marketplace links yet, so they are left EMPTY on purpose:
 *  an empty field means the agent says nothing about it (no material or claim wording is ever invented), and links are supplied per run. */
import type { Product } from "@/types";
import type { ContentCategory, ContentProduct } from "@/types/content-agent";

/** Free-text category -> the agent's fixed category, or undefined (the draft then says "piece" and nothing more specific). */
export function contentCategoryFor(text: string | null | undefined): ContentCategory | undefined {
  const t = (text ?? "").toLowerCase();
  if (/pendant/.test(t)) return "chain_pendant";
  if (/ear\s?ring|earring|stud|hoop|jhumk/.test(t)) return "earrings";
  if (/bracelet|bangle|kada/.test(t)) return "bracelet";
  if (/watch/.test(t)) return "watch_combo";
  if (/hair|clip|scrunch/.test(t)) return "hair_accessory";
  if (/chain|necklace/.test(t)) return "chain";
  if (/\bring/.test(t)) return "ring";
  return undefined;
}

export function contentProductFromProduct(p: Product): ContentProduct {
  return { id: p.id, name: p.name, category: contentCategoryFor(p.category), styleTags: [], approvedClaims: [], links: {}, isSample: false };
}

/** Archived products are not offered. Packs do not exist in the database yet. */
export const liveContentProducts = (products: Product[]): ContentProduct[] => products.filter((p) => p.status !== "archived").map(contentProductFromProduct);

export const LIVE_CONTENT_NOTE = "Products come from your catalogue. Style tags, material wording, approved claims and marketplace links are not stored yet, so drafts make no material or claim wording; add the marketplace links below.";
