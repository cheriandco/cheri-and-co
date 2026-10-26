import type {
  AgentEscalation, B2CIntent, CatalogueProduct, EscalationCode, ExtractedPreferences, NextActionCode, RecommendedProduct, SuggestedNextAction,
} from "@/types/b2c-agent";
import { formatSamplePrice, hasSearchCriteria, searchCatalogue } from "./search";

export interface ResponsePlan {
  draftResponse: string;
  autoAnswerPermitted: boolean;
  escalation: AgentEscalation;
  suggestedNextAction: SuggestedNextAction;
  recommendations: RecommendedProduct[];
}

const next = (code: NextActionCode, label: string, owner: "agent" | "human"): SuggestedNextAction => ({ code, label, owner });
const escalate = (code: EscalationCode, reason: string, priority: "high" | "normal" = "normal"): AgentEscalation => ({ required: true, code, reason, priority });
const NO_ESCALATION: AgentEscalation = { required: false };

export function isValidHttpUrl(value?: string): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const CLARIFY_OPTIONS = "the type of jewellery (earrings, necklace, ring, bracelet, anklet or set), the occasion or style, and a budget if you have one";

const HANDOVER: Partial<Record<B2CIntent, { code: EscalationCode; reason: string; priority: "high" | "normal"; draft: string }>> = {
  order_status: {
    code: "order_status", priority: "normal",
    reason: "Order status needs a check against real order records, which this prototype does not have.",
    draft: "Thanks for getting in touch. Order and delivery details can only be checked by our team against your actual order, so I can't share a status or delivery date here. A team member needs to review this. It will help to have your order number ready.",
  },
  return_refund: {
    code: "return_refund", priority: "high",
    reason: "Return and refund eligibility depends on the order and policy; it must be decided by a person.",
    draft: "Thanks for letting us know. Returns, exchanges and refunds depend on your order and our policy, which I can't confirm here, so I won't promise anything about eligibility or timelines. A team member needs to review this request.",
  },
  complaint: {
    code: "complaint", priority: "high",
    reason: "Customer complaint: needs personal attention from a team member.",
    draft: "I'm sorry to hear this. Your concern needs a team member's personal attention, so I won't offer a resolution here. A team member needs to review this before we reply.",
  },
};

const asRecommended = (p: CatalogueProduct, reason: string): RecommendedProduct => ({
  productId: p.id, name: p.name, category: p.category, matchScore: 100, matchReasons: [reason],
  samplePriceInr: p.samplePriceInr ?? null, priceLabel: formatSamplePrice(p.samplePriceInr),
});

const bullet = (r: RecommendedProduct) => `- ${r.name}: ${r.priceLabel}. ${r.matchReasons.join("; ")}.`;

const clarify = (lead: string, intro = "To suggest the right pieces, could you tell me"): ResponsePlan => ({
  draftResponse: `${lead} ${intro} ${CLARIFY_OPTIONS}?`.trim(),
  autoAnswerPermitted: true,
  escalation: NO_ESCALATION,
  suggestedNextAction: next("ask_clarifying_question", "Send the clarifying question to the customer (manually)", "agent"),
  recommendations: [],
});

const noConfidentMatch = (): ResponsePlan => ({
  draftResponse: "Thanks for your enquiry. I couldn't find a confident match in the catalogue for what you described, and I'd rather not guess. A team member needs to look at this and can suggest options.",
  autoAnswerPermitted: false,
  escalation: escalate("no_confident_match", "No catalogue product matched the stated criteria with enough confidence."),
  suggestedNextAction: next("handover_to_human", "Hand over to a team member to suggest alternatives", "human"),
  recommendations: [],
});

function missingInfo(draft: string, action: SuggestedNextAction, reason: string, recommendations: RecommendedProduct[] = []): ResponsePlan {
  return { draftResponse: draft, autoAnswerPermitted: false, escalation: escalate("missing_information", reason), suggestedNextAction: action, recommendations };
}

export function planResponse(
  intent: B2CIntent, prefs: ExtractedPreferences, catalogue: CatalogueProduct[], enquiryText: string,
): ResponsePlan {
  const handover = HANDOVER[intent];
  if (handover) {
    return {
      draftResponse: handover.draft, autoAnswerPermitted: false,
      escalation: escalate(handover.code, handover.reason, handover.priority),
      suggestedNextAction: next("handover_to_human", "Hand over to a team member", "human"), recommendations: [],
    };
  }
  if (intent === "other") {
    return {
      draftResponse: `Thanks for your message. I couldn't tell what you're looking for, so I won't guess. Could you share ${CLARIFY_OPTIONS}? A team member will pick this up if it's about something else.`,
      autoAnswerPermitted: false,
      escalation: escalate("unclear_request", "The request is ambiguous or outside what the sales agent can answer from the catalogue."),
      suggestedNextAction: next("handover_to_human", "Have a team member read the message and reply", "human"), recommendations: [],
    };
  }

  const product = prefs.productId ? catalogue.find((p) => p.id === prefs.productId) : undefined;
  const refRec = product ? [asRecommended(product, "You asked about this product")] : [];

  switch (intent) {
    case "product_recommendation":
    case "occasion_style_recommendation": {
      if (product) {
        // The customer named a specific product: answer about that one instead of listing others.
        const gaps = [...new Set(prefs.requestedMissingAttributes)];
        const gapNote = gaps.length ? ` I also don't have ${gaps.join(", ")} information in the catalogue.` : "";
        return missingInfo(
          `The ${product.name} is in our catalogue at ${formatSamplePrice(product.samplePriceInr)}. I can't confirm stock, delivery or discounts here, and I don't have a verified purchase link, so I won't promise any of those.${gapNote} A team member can help from here.`,
          next("confirm_details_with_team", "Have a team member confirm stock, price and share a verified link", "human"),
          "The customer named a specific product; stock, offers and purchase details need a person.", refRec,
        );
      }
      if (!hasSearchCriteria(prefs)) return clarify("Happy to help!");
      const recs = searchCatalogue(prefs, catalogue);
      if (!recs.length) return noConfidentMatch();
      const missing = prefs.requestedMissingAttributes.length
        ? `\n\nI don't have ${prefs.requestedMissingAttributes.join(", ")} information in the catalogue, so I can't answer that part; the team can confirm.`
        : "";
      return {
        draftResponse: `Here are some options from our catalogue that fit what you described:\n${recs.map(bullet).join("\n")}\n\nPrices shown are sample prices. I can't confirm stock, delivery or discounts here; the team can confirm those.${missing}`,
        autoAnswerPermitted: true, escalation: NO_ESCALATION,
        suggestedNextAction: next("send_recommendations", "Review the draft and send the recommendations to the customer (manually)", "agent"),
        recommendations: recs,
      };
    }

    case "price_enquiry": {
      if (product) {
        if (product.samplePriceInr == null) {
          return missingInfo(
            `I don't have a price for the ${product.name} in the catalogue, so I can't quote one. A team member can confirm it.`,
            next("confirm_details_with_team", "Ask the team to confirm the price", "human"), "The product has no price in the catalogue.", refRec,
          );
        }
        return {
          draftResponse: `The ${product.name} has a sample price of ${formatSamplePrice(product.samplePriceInr)} in our catalogue. I can't confirm discounts, offers or current pricing; the team can confirm those.`,
          autoAnswerPermitted: true, escalation: NO_ESCALATION,
          suggestedNextAction: next("send_answer", "Review the draft and send the answer to the customer (manually)", "agent"), recommendations: refRec,
        };
      }
      if (!hasSearchCriteria(prefs)) return clarify("Happy to share prices!", "Which product are you asking about? You can also tell me");
      const recs = searchCatalogue(prefs, catalogue);
      if (!recs.length) return noConfidentMatch();
      return {
        draftResponse: `Here are sample prices for matching pieces:\n${recs.map(bullet).join("\n")}\n\nThese are sample prices, not live prices. I can't confirm discounts or offers.`,
        autoAnswerPermitted: true, escalation: NO_ESCALATION,
        suggestedNextAction: next("send_answer", "Review the draft and send the answer to the customer (manually)", "agent"), recommendations: recs,
      };
    }

    case "product_details": {
      if (product) {
        const facts = [
          `Category: ${product.category}`, `Style: ${product.style}`, `Suited to: ${product.occasions.join(", ")}`,
          ...(product.material ? [`Material: ${product.material}`] : []), `Description: ${product.description}`,
        ];
        const asksMaterial = /\b(material|made (of|from)|metal)\b/.test(enquiryText);
        const gaps = [...prefs.requestedMissingAttributes, ...(asksMaterial && !product.material ? ["material"] : [])];
        const uniqueGaps = [...new Set(gaps)];
        if (uniqueGaps.length) {
          return missingInfo(
            `Here is what I have on the ${product.name}:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nI don't have ${uniqueGaps.join(", ")} information in the catalogue, so I can't answer that. A team member can confirm.`,
            next("confirm_details_with_team", `Ask the team to confirm: ${uniqueGaps.join(", ")}`, "human"),
            `The customer asked about ${uniqueGaps.join(", ")}, which is not in the catalogue.`, refRec,
          );
        }
        return {
          draftResponse: `Here is what I have on the ${product.name}:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nPrice: ${formatSamplePrice(product.samplePriceInr)}.`,
          autoAnswerPermitted: true, escalation: NO_ESCALATION,
          suggestedNextAction: next("send_answer", "Review the draft and send the answer to the customer (manually)", "agent"), recommendations: refRec,
        };
      }
      if (prefs.requestedMissingAttributes.length && !hasSearchCriteria(prefs)) {
        const gaps = prefs.requestedMissingAttributes.join(", ");
        return missingInfo(
          `I don't have verified information on ${gaps} in the catalogue, so I can't say. A team member can confirm. Which product are you asking about?`,
          next("confirm_details_with_team", `Ask the team to confirm: ${gaps}`, "human"), `The customer asked about ${gaps}, which is not in the catalogue.`,
        );
      }
      if (!hasSearchCriteria(prefs)) return clarify("Happy to share details!", "Which product are you asking about? You can also tell me");
      const recs = searchCatalogue(prefs, catalogue);
      if (!recs.length) return noConfidentMatch();
      return {
        draftResponse: `I'm not sure which product you mean. These match what you described:\n${recs.map(bullet).join("\n")}\n\nTell me which one and I can share its details.`,
        autoAnswerPermitted: true, escalation: NO_ESCALATION,
        suggestedNextAction: next("ask_clarifying_question", "Ask which product the customer means (manually)", "agent"), recommendations: recs,
      };
    }

    case "return_policy_enquiry":
      return missingInfo(
        "I don't have a verified return, exchange or refund policy in the catalogue, so I can't say whether returns are allowed or what the conditions or timelines are. A team member can confirm the policy before you buy.",
        next("confirm_details_with_team", "Ask the team to confirm the return policy", "human"), "Return policy is not available to the agent.", refRec,
      );

    case "shipping_enquiry":
      return missingInfo(
        "I don't have verified shipping or delivery information, so I can't promise a delivery date or timeline, or say whether shipping is free or what it costs. A team member can confirm this for you.",
        next("confirm_details_with_team", "Ask the team to confirm shipping details", "human"), "Shipping and delivery information is not available to the agent.", refRec,
      );

    case "discount_enquiry":
      return missingInfo(
        `I don't have verified information on discounts, offers or coupons, so I can't promise any${product ? ` for the ${product.name}` : ""}.${product?.samplePriceInr != null ? ` The catalogue lists a sample price of ${formatSamplePrice(product.samplePriceInr)}.` : ""} A team member can confirm what is available.`,
        next("confirm_details_with_team", "Ask the team to confirm current offers", "human"), "Discounts and offers are not available to the agent.", refRec,
      );

    case "availability_enquiry": {
      if (product) {
        const sampleNote = product.availability === "sample_in_stock"
          ? " The sample data marks it in stock, but that is illustrative, not live stock."
          : product.availability === "sample_out_of_stock" ? " The sample data marks it out of stock, but that is illustrative, not live stock." : "";
        return missingInfo(
          `I can't check live stock from here, so I can't confirm whether the ${product.name} is available.${sampleNote} A team member can check and confirm.`,
          next("check_stock_with_team", "Ask the team to check live stock", "human"), "Live stock is not available to the agent.", refRec,
        );
      }
      return missingInfo(
        "I can't check live stock from here, so I can't confirm availability. Which product are you asking about? A team member can check and confirm.",
        next("ask_clarifying_question", "Ask which product, then have the team check stock", "human"), "Live stock is not available to the agent.",
      );
    }

    case "purchase_link_request": {
      if (product && isValidHttpUrl(product.purchaseUrl)) {
        return {
          draftResponse: `Here is the link for the ${product.name}: ${product.purchaseUrl}`,
          autoAnswerPermitted: true, escalation: NO_ESCALATION,
          suggestedNextAction: next("share_verified_link_manually", "Check the link, then share it with the customer manually", "human"), recommendations: refRec,
        };
      }
      return missingInfo(
        `I don't have a verified purchase link${product ? ` for the ${product.name}` : ""} in the catalogue, so I won't guess one. A team member can share the right link.`,
        next("share_verified_link_manually", "Have a team member share a verified link", "human"), "No valid purchase URL is available in the catalogue.", refRec,
      );
    }

    default:
      return noConfidentMatch();
  }
}
