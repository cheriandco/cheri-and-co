// B2C Sales Agent contracts. Result shape is designed to map onto a future CRM interaction record.

export type B2CIntent =
  | "product_recommendation"
  | "price_enquiry"
  | "product_details"
  | "occasion_style_recommendation"
  | "availability_enquiry"
  | "purchase_link_request"
  | "order_status"
  | "return_refund"
  | "return_policy_enquiry"
  | "shipping_enquiry"
  | "discount_enquiry"
  | "complaint"
  | "other";

export type JewelleryCategory = "ring" | "necklace" | "earrings" | "bracelet" | "anklet" | "set";
export type JewelleryStyle = "minimal" | "traditional" | "statement" | "classic" | "boho";
export type JewelleryOccasion = "daily" | "office" | "party" | "wedding" | "festive" | "gift";

/** Prototype catalogue entry. Every value is SAMPLE data, not verified live Cheri & Co. information. */
export interface CatalogueProduct {
  id: string;
  name: string;
  category: JewelleryCategory;
  style: JewelleryStyle;
  occasions: JewelleryOccasion[];
  /** Only when known; absent means "not in the catalogue". */
  material?: string;
  /** Sample price in INR; absent means "no price in the catalogue". */
  samplePriceInr?: number;
  description: string;
  imagePath?: string;
  /** Only set when a valid URL is supplied. */
  purchaseUrl?: string;
  /** "unknown" unless the sample data explicitly says otherwise. Never live stock. */
  availability: "unknown" | "sample_in_stock" | "sample_out_of_stock";
  isSample: true;
}

export interface B2CAgentInput {
  enquiry: string;
}

export interface ExtractedPreferences {
  category?: JewelleryCategory;
  style?: JewelleryStyle;
  occasion?: JewelleryOccasion;
  material?: string;
  budgetMinInr?: number;
  budgetMaxInr?: number;
  /** Product explicitly referenced by id or name. */
  productId?: string;
  /** Attributes the customer asked about that the catalogue has no field for (e.g. weight, size). */
  requestedMissingAttributes: string[];
}

export interface RecommendedProduct {
  productId: string;
  name: string;
  category: JewelleryCategory;
  matchScore: number; // 0-100
  matchReasons: string[];
  samplePriceInr: number | null;
  priceLabel: string;
}

export type EscalationCode =
  | "order_status"
  | "return_refund"
  | "complaint"
  | "unclear_request"
  | "no_confident_match"
  | "missing_information";

export interface AgentEscalation {
  required: boolean;
  code?: EscalationCode;
  reason?: string;
  priority?: "high" | "normal";
}

export type NextActionCode =
  | "send_recommendations"
  | "send_answer"
  | "ask_clarifying_question"
  | "confirm_details_with_team"
  | "check_stock_with_team"
  | "share_verified_link_manually"
  | "handover_to_human";

export interface SuggestedNextAction {
  code: NextActionCode;
  label: string;
  owner: "agent" | "human";
}

export interface B2CAgentResult {
  enquiry: string;
  intent: B2CIntent;
  intentConfidence: number; // 0-1, rule-based
  preferences: ExtractedPreferences;
  recommendations: RecommendedProduct[];
  draftResponse: string;
  /** True only when the draft uses catalogue data alone and no human decision is needed. */
  autoAnswerPermitted: boolean;
  escalation: AgentEscalation;
  suggestedNextAction: SuggestedNextAction;
  dataSource: {
    kind: "prototype_sample_catalogue";
    verified: false;
    note: string;
  };
  /** Nothing is ever delivered to a customer by this prototype. */
  messageSent: false;
}
