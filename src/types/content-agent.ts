/** Content & Marketing Agent contracts. Everything here is a DRAFT: nothing is ever published. */

export type ContentCategory = "bracelet" | "chain_pendant" | "earrings" | "chain" | "ring" | "hair_accessory" | "watch_combo";

export const PACK_SIZES = [2, 3, 6, 10] as const;
export type PackSize = (typeof PACK_SIZES)[number];

/** Marketplace links must be supplied by the client; none are ever invented. */
export interface MarketplaceLinks {
  amazon?: string;
  flipkart?: string;
}

/** SAMPLE product. No price or stock field exists on purpose: the agent must never state either. */
export interface ContentProduct {
  id: string; // always "SAMPLE-P-…" for sample records
  name: string;
  category?: ContentCategory;
  styleTags: string[];
  /** Client-supplied material wording only. Absent means the agent says nothing about materials. */
  materialNote?: string;
  /** Claims the client has approved for this product, used verbatim. Empty means no claims. */
  approvedClaims: string[];
  links: MarketplaceLinks;
  isSample: boolean;
}

export type PackKind = "same_category" | "mixed";

/** SAMPLE combo pack built from member products. */
export interface ContentPack {
  id: string; // always "SAMPLE-PACK-…" for sample records
  name: string;
  size: PackSize;
  kind: PackKind;
  memberProductIds: string[];
  /** Only mentioned in copy when set. */
  packaging?: "pinterest_paper_box";
  approvedClaims: string[];
  links: MarketplaceLinks;
  isSample: boolean;
}

export type ContentTarget = { type: "product" | "pack"; id: string };

export type Audience = "everyday" | "college" | "work" | "gifting";
export const AUDIENCES: Audience[] = ["everyday", "college", "work", "gifting"];

/** Normalised input to the generator; every optional field can be missing. */
export interface ContentSubject {
  kind: "product" | "pack";
  name: string;
  pieceCount: number;
  categories: ContentCategory[];
  /** For a pack: one category per member, in order. Used for "2 × earrings, 1 × ring". */
  memberCategories: ContentCategory[];
  memberNames: string[];
  styleTags: string[];
  materialNote?: string;
  packaging?: "pinterest_paper_box";
  approvedClaims: string[];
  links: MarketplaceLinks;
  isSample: boolean;
}

export type IssueSeverity = "error" | "warning" | "info";
export type IssueCode =
  | "empty_name" | "missing_category" | "missing_style" | "missing_material" | "no_approved_claims"
  | "missing_marketplace_link" | "invalid_marketplace_link" | "prohibited_claim" | "sample_data" | "caption_too_long";

export interface ContentIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
}

export interface ReelScene { time: string; visual: string; onScreenText: string }
export interface AsmrCue { time: string; visual: string; sound: string }
export interface StoryFrame { frame: number; visual: string; text: string; sticker?: string }

export interface CanvaBrief {
  formats: { name: string; size: string }[];
  headline: string;
  supportingText: string;
  layout: string;
  palette: string;
  imagery: string;
  avoid: string[];
}

export interface MarketplaceCta {
  amazon: { supplied: boolean; line: string };
  flipkart: { supplied: boolean; line: string };
}

/** Pre-submission state of a draft. After submission the Approval record carries the status. */
export type ContentWorkflowStatus = "ai_generated" | "pending_review" | "approved" | "rejected";

export interface ContentDraft {
  status: "ai_generated";
  subject: { name: string; kind: "product" | "pack"; pieceCount: number; isSample: boolean };
  audience: Audience;
  instagramCaption: string;
  hashtags: string[];
  reelScript: { title: string; durationSeconds: number; scenes: ReelScene[]; audioNote: string };
  asmrScript: { title: string; durationSeconds: number; cues: AsmrCue[]; note: string };
  story: StoryFrame[];
  canvaBrief: CanvaBrief;
  cta: MarketplaceCta;
  issues: ContentIssue[];
  /** True when an error-level issue exists. Blocked drafts cannot be submitted for review. */
  blocked: boolean;
  /** Facts the draft is built from, so a reviewer can see what was and was not supplied. */
  factsUsed: string[];
  published: false;
  generator: "template";
  dataSource: { verified: false; note: string };
}
