/** Deterministic customer-reply drafts (the default, and the fallback whenever AI is off, refused or fails). Pure.
 *  A draft names catalogue products and at most one sentence of the owner's own description. It never states a price, a discount, a stock level
 *  or any claim (the claim guard checks the final text), never addresses the customer by name, and never promises a delivery or refund. */
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import type { EnquiryContext, ProductRecommendation } from "@/types/enquiry";
import { firstSentence } from "./recommend";

export const SIGN_OFF = "Cheri & Co.";

const HOLDING = "Thank you for getting in touch. We are sorry to hear this. A member of our team will look into it personally and come back to you.";

/** The text the guard scans. No claims are approved for live products, so any price, offer, stock, material or similar wording is a violation. */
export const replyViolations = (text: string) => findProhibitedClaims(text, []);

function productLine(r: ProductRecommendation, withDescription: boolean): string {
  const fact = withDescription ? firstSentence(r.description) : null;
  return `- ${r.name}${fact ? `: ${fact}` : ""}`;
}

function compose(context: EnquiryContext, recs: ProductRecommendation[], withDescription: boolean): string {
  if (context.needsHuman) return `${HOLDING}\n\n${SIGN_OFF}`;
  const money = context.intent === "price_enquiry" || context.intent === "discount_enquiry" || context.intent === "availability_enquiry";
  const intro = money
    ? "Thank you for your message. We will confirm the current details for you shortly."
    : "Thank you for your message.";
  if (!recs.length) {
    return [intro, "To suggest the right piece, could you tell us which kind of jewellery you are looking for (for example earrings, a bracelet or a pendant) and what it is for?", SIGN_OFF].join("\n\n");
  }
  if (context.scenario === "comparison" && recs.length >= 2) {
    const rows = recs.map((r) => {
      const fact = withDescription ? firstSentence(r.description) : null;
      return `- ${r.name}${r.category ? ` (${r.category})` : ""}${fact ? `: ${fact}` : ""}`;
    });
    return [intro, ["Here are the pieces you asked about, as described in our catalogue:", ...rows].join("\n"), "To help you choose, tell us what it is for and how you plan to wear it, and we will point you to the better fit.", SIGN_OFF].join("\n\n");
  }
  if (context.scenario === "purchase_intent") {
    const lines = recs.map((r) => productLine(r, false));
    return [
      "Thank you, we are glad you would like to go ahead. A member of our team will confirm the details and the next steps with you personally.",
      lines.length ? ["You are interested in:", ...lines].join("\n") : "Could you confirm which piece you would like?",
      SIGN_OFF,
    ].join("\n\n");
  }
  const lead = recs.length === 1 ? "This piece may suit what you are looking for:" : "These pieces may suit what you are looking for:";
  return [intro, [lead, ...recs.map((r) => productLine(r, withDescription))].join("\n"), "Would you like more details on any of these?", SIGN_OFF].join("\n\n");
}

/** The reply text. If the owner's description trips the claim guard it is left out; if the product names still do, the safe generic reply is used. */
export function templateReply(context: EnquiryContext, recs: ProductRecommendation[]): { body: string; note: string } {
  const full = compose(context, recs, true);
  if (!replyViolations(full).length) return { body: full, note: context.needsHuman ? "A holding reply was drafted: this kind of message needs a person." : "A template reply was built from the catalogue records." };
  const plain = compose(context, recs, false);
  if (!replyViolations(plain).length) return { body: plain, note: "A template reply was built; the product descriptions were left out because they contain wording that needs client-approved claims." };
  return { body: compose(context, [], false), note: "A generic reply was drafted because the product records contain wording that needs client-approved claims." };
}
