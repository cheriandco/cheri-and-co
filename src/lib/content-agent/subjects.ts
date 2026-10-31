import { PACK_SIZES } from "@/types/content-agent";
import type { ContentCategory, ContentPack, ContentProduct, ContentSubject, ContentTarget } from "@/types/content-agent";

export const CATEGORY_LABEL: Record<ContentCategory, { singular: string; plural: string }> = {
  bracelet: { singular: "bracelet", plural: "bracelets" },
  chain_pendant: { singular: "chain pendant", plural: "chain pendants" },
  earrings: { singular: "pair of earrings", plural: "earrings" },
  chain: { singular: "chain", plural: "chains" },
  ring: { singular: "ring", plural: "rings" },
  hair_accessory: { singular: "hair accessory", plural: "hair accessories" },
  watch_combo: { singular: "watch combo", plural: "watch combos" },
};

/** Structural problems with a pack definition. Empty array means valid. */
export function validatePack(pack: ContentPack, products: ContentProduct[]): string[] {
  const errors: string[] = [];
  if (!(PACK_SIZES as readonly number[]).includes(pack.size)) errors.push(`Pack size ${pack.size} is not supported (use 2, 3, 6 or 10).`);
  if (pack.memberProductIds.length !== pack.size) errors.push(`Pack "${pack.name}" lists ${pack.memberProductIds.length} pieces but its size is ${pack.size}.`);
  if (new Set(pack.memberProductIds).size !== pack.memberProductIds.length) errors.push(`Pack "${pack.name}" lists the same piece more than once.`);
  const known = new Set(products.map((x) => x.id));
  for (const id of pack.memberProductIds) if (!known.has(id)) errors.push(`Pack "${pack.name}" refers to unknown product ${id}.`);
  return errors;
}

export function subjectFromProduct(p: ContentProduct): ContentSubject {
  return {
    kind: "product", name: p.name, pieceCount: 1, categories: p.category ? [p.category] : [],
    memberCategories: p.category ? [p.category] : [], memberNames: [p.name], styleTags: p.styleTags,
    materialNote: p.materialNote, approvedClaims: p.approvedClaims, links: p.links, isSample: p.isSample,
  };
}

export function subjectFromPack(pack: ContentPack, products: ContentProduct[]): ContentSubject {
  const members = pack.memberProductIds.map((id) => products.find((x) => x.id === id)).filter((x): x is ContentProduct => !!x);
  const categories = [...new Set(members.flatMap((m) => (m.category ? [m.category] : [])))];
  return {
    kind: "pack", name: pack.name, pieceCount: pack.size, categories,
    memberCategories: members.flatMap((m) => (m.category ? [m.category] : [])), memberNames: members.map((m) => m.name),
    styleTags: [...new Set(members.flatMap((m) => m.styleTags))], packaging: pack.packaging,
    approvedClaims: pack.approvedClaims, links: pack.links, isSample: pack.isSample && members.every((m) => m.isSample),
  };
}

export type ResolveResult = { ok: true; subject: ContentSubject } | { ok: false; error: string };

/** Looks the target up and normalises it. Unknown ids and malformed packs are errors, never guessed. */
export function resolveSubject(target: ContentTarget, products: ContentProduct[], packs: ContentPack[]): ResolveResult {
  if (target.type === "product") {
    const p = products.find((x) => x.id === target.id);
    return p ? { ok: true, subject: subjectFromProduct(p) } : { ok: false, error: "Unknown product." };
  }
  const pack = packs.find((x) => x.id === target.id);
  if (!pack) return { ok: false, error: "Unknown pack." };
  const errors = validatePack(pack, products);
  return errors.length ? { ok: false, error: errors[0] } : { ok: true, subject: subjectFromPack(pack, products) };
}
