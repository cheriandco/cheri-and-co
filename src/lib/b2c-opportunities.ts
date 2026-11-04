/** M4: B2C sales opportunities from a customer's saved orders, and the generic follow-up draft.
 *  Pure functions: no network, no storage, nothing is sent. Every rule looks at the customer's MOST RECENT order only, so a
 *  customer gets at most one opportunity and it always points at one order. The day thresholds are PROVISIONAL defaults that the
 *  client must confirm before operational use.
 *
 *  The orders table records when an order was placed (ordered_at), not when it was delivered, so the repeat-purchase and win-back
 *  day counts use the order date, and the post-delivery check-in is NOT offered at all (see findOpportunities). */
import type { Order } from "@/types";

export const THRESHOLDS = {
  /** Repeat-purchase nudge (inclusive range). */
  repeat: { min: 30, max: 90 },
  /** Win-back: strictly more than this many days. */
  winBackAfter: 90,
  /** Unpaid/new order: status "new" for strictly more than this many days. */
  unpaidAfter: 3,
} as const;

export type OpportunityKind = "unpaid_order" | "repeat_nudge" | "win_back" | "review_returned";

export const KIND_LABELS: Record<OpportunityKind, string> = {
  unpaid_order: "Order still new",
  repeat_nudge: "Repeat-purchase nudge",
  win_back: "Win-back",
  review_returned: "Needs human review",
};

export const CONSENT_WARNING = "Consent not recorded — verify permission before contacting.";

export interface OpportunityCustomer { id: string; name: string; email: string; phone: string }

export interface Opportunity {
  customerId: string;
  customerName: string;
  kind: OpportunityKind;
  /** The one order the opportunity is about. */
  orderId: string;
  /** Whole days since that order was placed. */
  days: number;
  /** Plain-language reason shown to the team, using only saved facts. */
  reason: string;
  /** "contact_incomplete": no usable email or phone, so nothing can be drafted. */
  flags: "contact_incomplete"[];
  /** A draft may be created. False for returned/cancelled review cases and for customers with no usable contact. */
  draftable: boolean;
}

const DAY = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** At least one usable way to reach the customer: a plausible email or a phone with 6 or more digits. */
export function hasUsableContact(c: Pick<OpportunityCustomer, "email" | "phone">): boolean {
  return EMAIL.test(c.email.trim()) || c.phone.replace(/\D/g, "").length >= 6;
}

const RANK: Record<OpportunityKind, number> = { unpaid_order: 0, repeat_nudge: 1, win_back: 2, review_returned: 3 };

/** One opportunity per customer at most, decided from the most recent order:
 *  returned/cancelled -> review (flag only); new for more than 3 days -> unpaid;
 *  delivered 30-90 days ago -> repeat nudge; delivered more than 90 days ago -> win-back. Anything else (a recent paid or
 *  shipped order, a delivery 11-29 days ago, an order dated in the future, no orders) is no opportunity. */
export function findOpportunities(customers: OpportunityCustomer[], orders: Order[], now: Date = new Date()): Opportunity[] {
  const byCustomer = new Map<string, Order[]>();
  for (const o of orders) {
    if (!o.customerId || Number.isNaN(Date.parse(o.orderedAt))) continue;
    (byCustomer.get(o.customerId) ?? byCustomer.set(o.customerId, []).get(o.customerId)!).push(o);
  }
  const out: Opportunity[] = [];
  for (const c of customers) {
    const mine = byCustomer.get(c.id);
    if (!mine?.length) continue;
    const latest = [...mine].sort((a, b) => Date.parse(b.orderedAt) - Date.parse(a.orderedAt) || (a.id < b.id ? 1 : -1))[0];
    const days = Math.floor((now.getTime() - Date.parse(latest.orderedAt)) / DAY);
    if (days < 0) continue;
    let kind: OpportunityKind | null = null;
    let reason = "";
    if (latest.status === "cancelled" || latest.status === "returned") {
      kind = "review_returned";
      reason = `Latest order was ${latest.status} (${days} day${days === 1 ? "" : "s"} ago). Review it yourself; no sales message is suggested.`;
    } else if (latest.status === "new" && days > THRESHOLDS.unpaidAfter) {
      kind = "unpaid_order";
      reason = `Latest order has been marked new for ${days} days.`;
    } else if (latest.status === "delivered") {
      // There is deliberately NO post-delivery check-in here: the database records when an order was placed, not when it was
      // delivered, and a check-in sent before the parcel arrives would be wrong. It stays off until a real delivery timestamp exists.
      if (days >= THRESHOLDS.repeat.min && days <= THRESHOLDS.repeat.max) { kind = "repeat_nudge"; reason = `Latest delivered order is about ${days} days old.`; }
      else if (days > THRESHOLDS.winBackAfter) { kind = "win_back"; reason = `Latest delivered order is about ${days} days old, with no newer order.`; }
    }
    if (!kind) continue;
    const usable = hasUsableContact(c);
    out.push({
      customerId: c.id, customerName: c.name, kind, orderId: latest.id, days, reason,
      flags: usable ? [] : ["contact_incomplete"],
      draftable: usable && kind !== "review_returned",
    });
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.days - b.days || a.customerName.localeCompare(b.customerName) || (a.customerId < b.customerId ? -1 : 1));
}

const BODY: Record<Exclude<OpportunityKind, "review_returned">, string[]> = {
  unpaid_order: ["We are getting in touch about your recent order with Cheri & Co., which is still marked as new on our side.", "Please let us know if you need any help with it."],
  repeat_nudge: ["Thank you for shopping with Cheri & Co.", "If you are looking for something new, we would be glad to help."],
  win_back: ["It has been a while since your last order with Cheri & Co., and we would love to hear from you again.", "We are happy to help if there is anything you are looking for."],
};

/** A generic, factual draft. It states no price, discount, stock, product or purchase detail, and leaves a placeholder for
 *  products or offers the client has approved. It is a template, not AI-written text, and it is never sent by the app. */
export function b2cFollowUpDraft(customer: OpportunityCustomer, opp: Opportunity): { title: string; preview: string } {
  if (opp.kind === "review_returned") throw new Error("No sales draft exists for a review case");
  const name = customer.name.trim();
  const first = name.split(/\s+/)[0] || "there";
  const contact = [customer.email.trim(), customer.phone.trim()].filter(Boolean).join(" · ");
  return {
    title: `B2C follow-up — ${name || "Customer"}`,
    preview: [
      `[Internal note, delete before sending: ${CONSENT_WARNING} Nothing has been sent.]`,
      `To: ${name || "Customer"}${contact ? ` (${contact})` : ""}`,
      "Channel: choose when sending (Instagram, WhatsApp or email)",
      "",
      `Hi ${first},`,
      "",
      ...BODY[opp.kind],
      "",
      "[Add client-approved products or offer here, if any.]",
      "",
      "Warm regards,",
      "Cheri & Co. team",
    ].join("\n"),
  };
}
