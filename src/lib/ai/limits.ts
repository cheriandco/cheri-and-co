/** Spend and rate controls that need NO database migration.
 *  - Calls and estimated spend are recorded as rows in the EXISTING append-only `agent_activity` table (the ledger), through the
 *    signed-in user's own session, so Row Level Security applies and no service-role key is involved.
 *  - Every attempt is RESERVED before the network call, at a conservative worst-case cost, and never refunded (a failed or timed-out
 *    attempt still counts). Reserve first, then re-count: concurrent requests can overshoot by at most the number in flight.
 *  - A per-user per-minute limit is kept in memory. It is per server instance, so it is a courtesy brake, not a hard guarantee.
 *  - If the ledger cannot be read or written, the call is REFUSED (fail closed).
 *  Estimated cost is worst case: all the input at the input price plus the full output allowance at the output price. Real cost is lower. */
import type { AgentKey } from "@/types";
import type { AiConfig } from "./config";

export interface LedgerRow { action: string; at: string }

/** Implemented over `agent_activity` in src/services/ai-ledger.ts; an in-memory version lives in the tests. */
export interface AiLedger {
  /** Every ledger row of this organisation at or after `sinceIso` (UTC ISO timestamp). */
  usage(sinceIso: string): Promise<LedgerRow[]>;
  record(action: string, agent: AgentKey): Promise<void>;
}

export const LEDGER_PREFIX = "AI call v1 | ";
export const formatLedgerAction = (agent: AgentKey, model: string, estCostUsd: number): string =>
  `${LEDGER_PREFIX}${agent} | ${model} | cost_usd=${estCostUsd.toFixed(6)}`;

export function parseLedgerCost(action: string): number {
  const m = /cost_usd=(\d+(?:\.\d+)?)/.exec(action);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export const monthStartUtc = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const dayStartUtc = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Deliberately high (3 characters per token) so the estimate errs toward spending less. */
export const estimateInputTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 3);

export function worstCaseCostUsd(inputChars: number, cfg: Pick<AiConfig, "priceInPerMTok" | "priceOutPerMTok" | "maxOutputTokens">): number | null {
  if (cfg.priceInPerMTok === null || cfg.priceOutPerMTok === null) return null;
  return (estimateInputTokens(inputChars) * cfg.priceInPerMTok + cfg.maxOutputTokens * cfg.priceOutPerMTok) / 1_000_000;
}

/** Sliding-window limiter, in memory. */
export class CallRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs = 60_000) {}
  allow(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => nowMs - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export type RefuseReason = "pricing_not_configured" | "rate_limited" | "daily_cap" | "monthly_cap" | "ledger_unavailable";
export type ReserveResult = { ok: true; estCostUsd: number } | { ok: false; reason: RefuseReason };

export interface ReserveArgs {
  ledger: AiLedger;
  config: AiConfig;
  limiter: CallRateLimiter;
  userKey: string;
  agent: AgentKey;
  /** Size of everything that will be sent (instructions plus input). */
  inputChars: number;
  now?: Date;
}

/** Totals for the current UTC day and month, from ledger rows (the month query already contains the day). */
export function totals(rows: LedgerRow[], now: Date): { callsToday: number; spentMonthUsd: number } {
  const day = dayStartUtc(now).getTime();
  let callsToday = 0;
  let spentMonthUsd = 0;
  for (const r of rows) {
    if (!r.action.startsWith(LEDGER_PREFIX)) continue;
    spentMonthUsd += parseLedgerCost(r.action);
    if (Date.parse(r.at) >= day) callsToday += 1;
  }
  return { callsToday, spentMonthUsd };
}

export async function reserveAiCall(a: ReserveArgs): Promise<ReserveResult> {
  const now = a.now ?? new Date();
  const est = worstCaseCostUsd(a.inputChars, a.config);
  if (est === null) return { ok: false, reason: "pricing_not_configured" };
  if (!a.limiter.allow(a.userKey, now.getTime())) return { ok: false, reason: "rate_limited" };

  const since = monthStartUtc(now).toISOString();
  try {
    const before = totals(await a.ledger.usage(since), now);
    if (before.callsToday >= a.config.dailyCallsPerOrg) return { ok: false, reason: "daily_cap" };
    if (before.spentMonthUsd + est > a.config.monthlyBudgetUsd) return { ok: false, reason: "monthly_cap" };
    await a.ledger.record(formatLedgerAction(a.agent, a.config.model, est), a.agent);
    const after = totals(await a.ledger.usage(since), now); // includes this reservation: catches a concurrent overshoot
    if (after.callsToday > a.config.dailyCallsPerOrg) return { ok: false, reason: "daily_cap" };
    if (after.spentMonthUsd > a.config.monthlyBudgetUsd) return { ok: false, reason: "monthly_cap" };
  } catch {
    return { ok: false, reason: "ledger_unavailable" };
  }
  return { ok: true, estCostUsd: est };
}

/** Plain-language reason for the user. */
export function describeRefusal(reason: RefuseReason): string {
  switch (reason) {
    case "rate_limited": return "AI drafting is paused for a moment because too many requests were made. Try again in a minute";
    case "daily_cap": return "AI drafting has reached today's limit for your organisation";
    case "monthly_cap": return "AI drafting has reached this month's spending limit";
    case "pricing_not_configured": return "AI drafting is not fully configured";
    default: return "AI drafting could not check its usage limits";
  }
}
