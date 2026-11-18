/** B2C Sales Agent (live organisations): enquiries, the conversation history, recommendations and follow-ups.
 *  Nothing here is ever sent to a customer. "approved" means a person approved the wording, not that it was delivered. */
import type { B2CIntent } from "./b2c-agent";

export const ENQUIRY_SOURCES = ["instagram", "whatsapp", "email", "phone", "website", "walk_in", "marketplace", "other"] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];

export const ENQUIRY_STATUSES = ["new", "draft_ready", "awaiting_approval", "approved", "replied", "closed"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export type MessageDirection = "inbound" | "outbound";
/** received: an inbound message. sent_manually: a person recorded that they sent it OUTSIDE this app. The app never sends. */
export type MessageStatus = "received" | "draft" | "pending_approval" | "approved" | "rejected" | "sent_manually";
export type MessageAuthor = "customer" | "human" | "template" | "ai";

export interface EnquiryMessage {
  id: string;
  enquiryId: string;
  direction: MessageDirection;
  body: string;
  status: MessageStatus;
  productId: string | null;
  approvalId: string | null;
  generatedBy: MessageAuthor;
  model: string | null;
  createdAt: string;
}

export interface Enquiry {
  id: string;
  customerId: string | null;
  productId: string | null;
  source: EnquirySource;
  status: EnquiryStatus;
  subject: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface EnquiryFollowUp { id: string; title: string; dueAt: string | null; status: "open" | "done" | "postponed"; priority: "high" | "medium" | "low"; assigneeId: string | null }
export interface EnquiryHistoryEntry { at: string; action: string }

export interface Page { limit: number; offset: number; hasMore: boolean }

export interface EnquiryDetail extends Enquiry { messages: EnquiryMessage[]; followUps: EnquiryFollowUp[]; history: EnquiryHistoryEntry[] }

/** Contact details for a customer who is not in the CRM yet. At least a name plus one way to reach them (email, phone or Instagram handle). */
export interface NewCustomerInput { name: string; email: string | null; phone: string | null; instagram: string | null; city: string | null }

export interface EnquiryInput {
  source: EnquirySource;
  /** An existing customer. Mutually exclusive with `customer`. */
  customerId: string | null;
  /** Find-or-create: an existing customer with the same email, phone or Instagram handle is reused, otherwise one is created. */
  customer?: NewCustomerInput | null;
  productId: string | null;
  /** What the customer wrote. Stored in the organisation's own database only; never sent to an AI provider. */
  message: string;
}

/** A catalogue record the reply may be built on. Every field comes from the products table; none is invented. */
export interface ProductRecommendation {
  productId: string;
  name: string;
  category: string;
  /** From the record, for the person reading it. It is never written into a draft (the claim guard forbids prices in copy). */
  price: number | null;
  /** The stock figure on the record, or null when none is recorded. */
  stock: number | null;
  status: "active" | "draft" | "low_stock" | "archived";
  score: number;
  /** Why it matched, in plain words, each traceable to the record. */
  reasons: string[];
  /** The catalogue fields the match used. */
  matchedOn: ("name" | "category" | "description")[];
  description: string | null;
  /** The owner's https picture link from the record, or null when none is recorded. */
  imageUrl: string | null;
  /** What the record is missing for a good answer (no description, no image, no price, no stock figure). Never filled in with guesses. */
  catalogueGaps: string[];
}

/** What kind of conversation this is. needs_human wins over everything else. */
export type EnquiryScenario = "product_enquiry" | "comparison" | "purchase_intent" | "general" | "needs_human";

export interface EnquiryContext {
  scenario: EnquiryScenario;
  intent: B2CIntent;
  intentConfidence: number;
  /** True when a person must handle it (complaint, refund, order status): no AI is used and the draft is a holding reply. */
  needsHuman: boolean;
  humanReason?: string;
  /** Closed-vocabulary words found in the enquiry (category, occasion, style, budget band). Never free text. */
  keywords: string[];
}

export interface ReplyOutcome {
  body: string;
  generator: "template" | "ai";
  model?: string;
  promptVersion?: string;
  note: string;
  recommendations: ProductRecommendation[];
  context: EnquiryContext;
}

/** The seam for future messaging. Nothing implements it yet: no WhatsApp, SMS or email integration exists, and no code calls it. */
export interface OutboundChannel {
  readonly channel: EnquirySource;
  /** Would hand an APPROVED message to a provider. Intentionally unimplemented. */
  deliver(message: EnquiryMessage): Promise<{ delivered: boolean }>;
}
