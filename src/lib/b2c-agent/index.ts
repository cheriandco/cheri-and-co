import type { B2CAgentInput, B2CAgentResult, CatalogueProduct } from "@/types/b2c-agent";
import { CATALOGUE_DATA_NOTE, SAMPLE_CATALOGUE } from "@/mocks/catalogue";
import { classifyIntent, normalise } from "./intent";
import { extractPreferences } from "./preferences";
import { planResponse } from "./respond";

export { classifyIntent } from "./intent";
export { extractPreferences, extractBudget } from "./preferences";
export { searchCatalogue } from "./search";

/**
 * Deterministic B2C Sales Agent. Pure function: no network, no storage, no side effects.
 * It only drafts; nothing is ever sent to a customer.
 */
export function runB2CAgent(input: B2CAgentInput, catalogue: CatalogueProduct[] = SAMPLE_CATALOGUE): B2CAgentResult {
  const enquiry = (input?.enquiry ?? "").trim();
  const { intent, confidence } = classifyIntent(enquiry);
  const preferences = extractPreferences(enquiry, catalogue);
  const plan = planResponse(intent, preferences, catalogue, normalise(enquiry));
  return {
    enquiry,
    intent,
    intentConfidence: confidence,
    preferences,
    recommendations: plan.recommendations,
    draftResponse: plan.draftResponse,
    autoAnswerPermitted: plan.autoAnswerPermitted,
    escalation: plan.escalation,
    suggestedNextAction: plan.suggestedNextAction,
    dataSource: { kind: "prototype_sample_catalogue", verified: false, note: CATALOGUE_DATA_NOTE },
    messageSent: false,
  };
}
