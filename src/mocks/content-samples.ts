/** SAMPLE product and pack records for the Content & Marketing Agent prototype.
 *  Invented structure only: names are generic, and there are deliberately NO prices, stock figures, materials,
 *  approved claims or marketplace links. The real catalogue has not been supplied by the client.
 *  Do not publish anything generated from these records. */
import type { ContentPack, ContentProduct } from "@/types/content-agent";

export const CONTENT_SAMPLE_NOTE =
  "SAMPLE data: invented names and structure only. No prices, stock, materials, claims or marketplace links have been supplied by the client, so none appear in drafts.";

const p = (n: number, name: string, category: ContentProduct["category"], styleTags: string[]): ContentProduct => ({
  id: `SAMPLE-P-${String(n).padStart(3, "0")}`, name, category, styleTags, approvedClaims: [], links: {}, isSample: true,
});

export const contentProducts: ContentProduct[] = [
  p(1, "Minimal Chain Bracelet", "bracelet", ["minimal", "everyday"]),
  p(2, "Heart Pendant Chain", "chain_pendant", ["minimal"]),
  p(3, "Hoop Earrings", "earrings", ["minimal", "everyday"]),
  p(4, "Drop Earrings", "earrings", ["minimal"]),
  p(5, "Twisted Band Ring", "ring", ["minimal"]),
  p(6, "Bow Hair Clip", "hair_accessory", ["everyday"]),
  p(7, "Slim Chain", "chain", ["minimal", "layering"]),
  p(8, "Stud Earrings", "earrings", ["minimal", "everyday"]),
  p(9, "Watch and Bracelet Combo", "watch_combo", ["minimal"]),
  p(10, "Stackable Ring", "ring", ["minimal", "stacking"]),
];

const pack = (n: number, name: string, size: ContentPack["size"], kind: ContentPack["kind"], members: number[], packaging?: ContentPack["packaging"]): ContentPack => ({
  id: `SAMPLE-PACK-${String(n).padStart(3, "0")}`, name, size, kind,
  memberProductIds: members.map((m) => `SAMPLE-P-${String(m).padStart(3, "0")}`),
  ...(packaging ? { packaging } : {}), approvedClaims: [], links: {}, isSample: true,
});

/** One pack per supported size. Pack 003 deliberately has no packaging set, to exercise the missing-information path. */
export const contentPacks: ContentPack[] = [
  pack(1, "Earring Duo", 2, "same_category", [3, 4], "pinterest_paper_box"),
  pack(2, "Everyday Trio", 3, "mixed", [1, 2, 3], "pinterest_paper_box"),
  pack(3, "Curated Six", 6, "mixed", [1, 3, 4, 5, 6, 8]),
  pack(4, "Curated Ten", 10, "mixed", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "pinterest_paper_box"),
];
