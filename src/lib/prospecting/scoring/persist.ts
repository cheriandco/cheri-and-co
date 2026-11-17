/** What may be stored permanently from an evaluation (class P). Numbers, bands, statuses and fixed rule codes only.
 *
 *  Two modes, because whether even derived codes may be kept is open legal question R1:
 *    "codes"       points per criterion, rule codes and flags;
 *    "band_total"  the fallback: only status, band and total.
 *  Neither mode can contain Google text, because the evaluation never holds any. */
import type { CriterionKey } from "./config";
import type { Evaluation, OutcomeStatus } from "./outcome";
import type { ReviewFlag, RuleCode } from "./rubric";

export type PersistMode = "codes" | "band_total";

export interface PersistableEvaluation {
  configVersion: string;
  status: OutcomeStatus;
  band?: "high" | "medium" | "low";
  total: number;
  ruleCode?: string;
  matchedId?: string;
  points?: Record<CriterionKey, number>;
  codes?: RuleCode[];
  flags?: ReviewFlag[];
}

export function toPersistable(e: Evaluation, mode: PersistMode): PersistableEvaluation {
  const { outcome, score } = e;
  const out: PersistableEvaluation = { configVersion: score.configVersion, status: outcome.status, total: score.total, band: score.band };
  if (outcome.status === "duplicate") { out.ruleCode = outcome.rule; out.matchedId = outcome.matchedId; }
  if (outcome.status === "rejected") out.ruleCode = outcome.rule;
  if (mode === "codes") {
    const keys = Object.keys(score.criteria) as CriterionKey[];
    out.points = Object.fromEntries(keys.map((k) => [k, score.criteria[k].points])) as Record<CriterionKey, number>;
    out.codes = keys.flatMap((k) => score.criteria[k].codes);
    out.flags = [...score.flags];
  }
  return out;
}
