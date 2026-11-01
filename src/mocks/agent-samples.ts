/** SAMPLE retailer-discovery candidates for the B2B Lead Agent demo. Invented businesses: nothing here came from Google
 *  Maps, Places or any directory, and no real retailer is described. */
export interface DiscoveryCandidate {
  id: string;
  business: string;
  location: string;
  category: string;
  instagram: string;
  website: string;
  contact: string;
  /** Signals the rule-based fit score uses. */
  signals: { stocksJewellery: boolean; tier: 1 | 2 | 3; hasInstagram: boolean; hasWebsite: boolean; stores: number };
}

export const DISCOVERY_NOTE =
  "SAMPLE candidates from a fixed demo list. No search is run against Google Maps, Places or any directory, and none of these businesses is real.";

export const discoveryCandidates: DiscoveryCandidate[] = [
  { id: "dc1", business: "SAMPLE · Rosewood Gifts", location: "Nagpur, Maharashtra", category: "Gifting store", instagram: "@rosewood.sample", website: "rosewood-gifts.example", contact: "Contact to be confirmed",
    signals: { stocksJewellery: true, tier: 2, hasInstagram: true, hasWebsite: true, stores: 2 } },
  { id: "dc2", business: "SAMPLE · Teal & Thread Boutique", location: "Indore, Madhya Pradesh", category: "Fashion boutique", instagram: "@tealthread.sample", website: "tealthread.example", contact: "Contact to be confirmed",
    signals: { stocksJewellery: true, tier: 2, hasInstagram: true, hasWebsite: false, stores: 1 } },
  { id: "dc3", business: "SAMPLE · Bhopal Bangle House", location: "Bhopal, Madhya Pradesh", category: "Jewellery boutique", instagram: "@bangle.sample", website: "bangle-house.example", contact: "Contact to be confirmed",
    signals: { stocksJewellery: true, tier: 2, hasInstagram: true, hasWebsite: true, stores: 3 } },
  { id: "dc4", business: "SAMPLE · Little Luxe Corner", location: "Ahmedabad, Gujarat", category: "Beauty & accessories", instagram: "@littleluxe.sample", website: "", contact: "Contact to be confirmed",
    signals: { stocksJewellery: false, tier: 1, hasInstagram: true, hasWebsite: false, stores: 1 } },
  { id: "dc5", business: "SAMPLE · Kesar Lane Accessories", location: "Udaipur, Rajasthan", category: "Accessories", instagram: "", website: "kesarlane.example", contact: "Contact to be confirmed",
    signals: { stocksJewellery: true, tier: 3, hasInstagram: false, hasWebsite: true, stores: 1 } },
  { id: "dc6", business: "SAMPLE · Moonstone Mall Kiosk", location: "Raipur, Chhattisgarh", category: "Mall kiosk", instagram: "@moonstone.sample", website: "", contact: "Contact to be confirmed",
    signals: { stocksJewellery: true, tier: 3, hasInstagram: true, hasWebsite: false, stores: 1 } },
];
