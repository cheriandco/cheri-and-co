/** Outcomes and exclusion rules (specification section 4.3). The first matching rule applies.
 *
 *  Only two kinds of outcome are conclusions the system may reach on its own:
 *    1. Duplicate (a recorded link a person can undo), and
 *    2. Rejected on a hard VERIFIED fact: permanently closed, or an address verified to be outside every configured location.
 *  Everything else only routes the candidate to a person. There is NO "qualified" outcome: the union below cannot express it. Acceptance
 *  into the CRM is a separate human action that this module does not implement. */
import type { GoogleTransient } from "../transient";
import { DEFAULT_SCORING_CONFIG, type CampaignLocation, type ScoringConfig } from "./config";
import { detectDuplicate, type DuplicateMatch, type KnownBusiness } from "./duplicates";
import { criteriaWithEvidence, scorePlace, type HumanEvidence, type ScoreResult } from "./rubric";

export type RejectRule = "HARD_PERMANENTLY_CLOSED" | "HARD_OUTSIDE_LOCATIONS";

export type Outcome =
  | { status: "duplicate"; rule: DuplicateMatch["rule"]; matchedId: string; undoable: boolean }
  | { status: "rejected"; rule: RejectRule }
  | { status: "insufficient_information" }
  | { status: "needs_review"; band: ScoreResult["band"] };

export type OutcomeStatus = Outcome["status"];

export interface Evaluation { outcome: Outcome; score: ScoreResult }

export interface EvaluateInput {
  place: GoogleTransient;
  locations: readonly CampaignLocation[];
  known?: readonly KnownBusiness[];
  human?: HumanEvidence;
  detailsFresh?: boolean;
}

/** Decides the outcome from an already-computed score (so callers that stored one can re-decide). */
export function decideOutcome(score: ScoreResult, duplicate: DuplicateMatch | undefined, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): Outcome {
  if (duplicate) return { status: "duplicate", rule: duplicate.rule, matchedId: duplicate.matchedId, undoable: duplicate.undoable };
  if (score.businessStatus === "CLOSED_PERMANENTLY") return { status: "rejected", rule: "HARD_PERMANENTLY_CLOSED" };
  if (score.geography.outside) return { status: "rejected", rule: "HARD_OUTSIDE_LOCATIONS" };
  if (criteriaWithEvidence(score) < cfg.minCriteriaWithEvidence) return { status: "insufficient_information" };
  return { status: "needs_review", band: score.band };
}

export function evaluateCandidate(input: EvaluateInput, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): Evaluation {
  const score = scorePlace({ place: input.place, locations: input.locations, human: input.human, detailsFresh: input.detailsFresh }, cfg);
  const duplicate = detectDuplicate(input.place, input.known ?? [], cfg);
  return { outcome: decideOutcome(score, duplicate, cfg), score };
}
