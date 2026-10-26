import type { CatalogueProduct } from "@/types/b2c-agent";

/**
 * PROTOTYPE SAMPLE CATALOGUE.
 * These products, prices and descriptions are invented for testing the B2C Sales Agent.
 * They are NOT verified Cheri & Co. products, prices, stock or links. Replace this module
 * (or the `getCatalogue` service) with the real catalogue later; agent logic does not depend on it.
 * Several fields are deliberately missing (material, price) to exercise "unknown" handling.
 */
export const CATALOGUE_DATA_NOTE =
  "Prototype sample catalogue: products, prices and availability are illustrative, not verified Cheri & Co. data.";

type Seed = Omit<CatalogueProduct, "availability" | "isSample">;

const seed: Seed[] = [
  { id: "SAMPLE-ERG-001", name: "Petal Stud Earrings", category: "earrings", style: "minimal", occasions: ["daily", "office"], material: "Gold-tone brass (sample)", samplePriceInr: 1299, description: "Small petal-shaped studs for everyday wear." },
  { id: "SAMPLE-ERG-002", name: "Jhumka Bloom Earrings", category: "earrings", style: "traditional", occasions: ["festive", "wedding"], samplePriceInr: 2499, description: "Dome jhumkas with a floral motif." },
  { id: "SAMPLE-ERG-003", name: "Pearl Drop Earrings", category: "earrings", style: "classic", occasions: ["party", "wedding"], material: "Faux pearl, gold-tone setting (sample)", samplePriceInr: 1899, description: "Single pearl drops on a slim hook." },
  { id: "SAMPLE-ERG-004", name: "Statement Tassel Earrings", category: "earrings", style: "statement", occasions: ["party"], samplePriceInr: 1599, description: "Long tassel earrings with a bold silhouette." },
  { id: "SAMPLE-ERG-005", name: "Minimal Hoop Earrings", category: "earrings", style: "minimal", occasions: ["daily", "office", "gift"], material: "Gold-tone brass (sample)", samplePriceInr: 1099, description: "Slim hoops that pair with most outfits." },
  { id: "SAMPLE-NCK-001", name: "Solitaire Pendant Necklace", category: "necklace", style: "minimal", occasions: ["daily", "office", "gift"], material: "Gold-tone chain with cubic zirconia (sample)", samplePriceInr: 2199, description: "Fine chain with a single stone pendant." },
  { id: "SAMPLE-NCK-002", name: "Kundan Choker Necklace", category: "necklace", style: "traditional", occasions: ["wedding", "festive"], samplePriceInr: 5999, description: "Choker-length necklace in a kundan-inspired design." },
  { id: "SAMPLE-NCK-003", name: "Layered Chain Necklace", category: "necklace", style: "boho", occasions: ["party", "daily"], samplePriceInr: 1799, description: "Three layered chains of different lengths." },
  { id: "SAMPLE-NCK-004", name: "Pearl Strand Necklace", category: "necklace", style: "classic", occasions: ["wedding", "gift"], material: "Faux pearls (sample)", samplePriceInr: 3499, description: "A single strand of pearl-style beads." },
  { id: "SAMPLE-RNG-001", name: "Twist Band Ring", category: "ring", style: "minimal", occasions: ["daily"], material: "Gold-tone brass (sample)", samplePriceInr: 999, description: "Slim twisted band." },
  { id: "SAMPLE-RNG-002", name: "Cocktail Stone Ring", category: "ring", style: "statement", occasions: ["party"], samplePriceInr: 1499, description: "Large central stone ring." },
  { id: "SAMPLE-RNG-003", name: "Adjustable Floral Ring", category: "ring", style: "boho", occasions: ["gift", "daily"], description: "Open-back floral ring." },
  { id: "SAMPLE-BRC-001", name: "Charm Bracelet", category: "bracelet", style: "boho", occasions: ["gift", "daily"], samplePriceInr: 1699, description: "Chain bracelet with small charms." },
  { id: "SAMPLE-BRC-002", name: "Kada Bangle", category: "bracelet", style: "traditional", occasions: ["festive", "wedding"], samplePriceInr: 2799, description: "Broad kada-style bangle with engraved detailing." },
  { id: "SAMPLE-BRC-003", name: "Tennis Bracelet", category: "bracelet", style: "classic", occasions: ["party", "wedding"], material: "Silver-tone with cubic zirconia (sample)", samplePriceInr: 2999, description: "A row of small stones on a flexible band." },
  { id: "SAMPLE-ANK-001", name: "Silver-tone Anklet Pair", category: "anklet", style: "minimal", occasions: ["daily"], material: "Silver-tone brass (sample)", samplePriceInr: 899, description: "A pair of fine-chain anklets." },
  { id: "SAMPLE-SET-001", name: "Bridal Necklace and Earrings Set", category: "set", style: "traditional", occasions: ["wedding"], samplePriceInr: 8999, description: "Matching necklace and earrings in a traditional design." },
  { id: "SAMPLE-SET-002", name: "Festive Jewellery Set", category: "set", style: "traditional", occasions: ["festive", "gift"], samplePriceInr: 4499, description: "Coordinated necklace and earrings for festive occasions." },
];

export const SAMPLE_CATALOGUE: CatalogueProduct[] = seed.map((p) => ({ ...p, availability: "unknown", isSample: true }));
