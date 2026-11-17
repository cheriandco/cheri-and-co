/** Usage-tracking and spending-gate INTERFACES (specification section 5.7), plus in-memory implementations for tests and local use.
 *
 *  The client calls `BudgetGate.reserve` before EVERY network attempt (retries included) and never makes the call if it is refused.
 *  In a later phase the gate is backed by an atomic database function; here it only defines the contract. Reservations are never
 *  refunded: a failed attempt still counts (conservative; Google's billing of failed requests is unverified).
 *  Usage events hold counts, timings and fixed codes. They never hold Google content. */
import type { FieldTier } from "./field-masks";
import type { PlacesOperation } from "./transport";

/** Assumed list prices in US$ per 1,000 requests, at the TOP tier so estimates err high. From memory: UNVERIFIED until Phase 8. */
export const ASSUMED_PRICE_USD_PER_1000: Record<PlacesOperation, number> = { searchText: 35, placeDetails: 20 };

export function estimateCostUsd(operation: PlacesOperation, prices: Record<PlacesOperation, number> = ASSUMED_PRICE_USD_PER_1000): number {
  return prices[operation] / 1000;
}

/** Worst-case size and cost of a run, shown BEFORE anything is called (specification step 2). Uses the assumed prices above. */
export function estimateRun(plan: { searchUnits: number; maxPagesPerUnit: number; maxDetailCalls: number }, prices: Record<PlacesOperation, number> = ASSUMED_PRICE_USD_PER_1000): { maxRequests: number; maxCostUsd: number } {
  const searches = Math.max(0, plan.searchUnits) * Math.max(0, plan.maxPagesPerUnit);
  const details = Math.max(0, plan.maxDetailCalls);
  return { maxRequests: searches + details, maxCostUsd: searches * estimateCostUsd("searchText", prices) + details * estimateCostUsd("placeDetails", prices) };
}

export interface ReserveRequest { operation: PlacesOperation; tier: FieldTier; estimatedCostUsd: number }
export type ReserveDecision = { ok: true } | { ok: false; reason: "cap_reached" | "stopped" };

export interface BudgetGate { reserve(req: ReserveRequest): Promise<ReserveDecision> }

export type UsageOutcome = "ok" | "http_error" | "throttled" | "timeout" | "network" | "invalid_response";

export interface UsageEvent {
  operation: PlacesOperation;
  outcome: UsageOutcome;
  status?: number;
  /** 0 for the first attempt. */
  attempt: number;
  durationMs: number;
  at: string;
}

export interface UsageSink { record(event: UsageEvent): void | Promise<void> }

export class NoopUsageSink implements UsageSink { record(): void { /* intentionally nothing */ } }

export class MemoryUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];
  record(event: UsageEvent): void { this.events.push(event); }
}

/** A single-process gate with a request cap, an optional cost cap and a stop switch. Check-and-increment is synchronous, so concurrent callers
 *  in one process cannot overshoot; the database version must give the same guarantee across processes. */
export class InMemoryBudgetGate implements BudgetGate {
  requestsUsed = 0;
  costUsed = 0;
  private stopped = false;
  constructor(private readonly caps: { maxRequests: number; maxCostUsd?: number }) {}
  stop(): void { this.stopped = true; }
  resume(): void { this.stopped = false; }
  async reserve(req: ReserveRequest): Promise<ReserveDecision> {
    if (this.stopped) return { ok: false, reason: "stopped" };
    if (this.requestsUsed + 1 > this.caps.maxRequests) return { ok: false, reason: "cap_reached" };
    if (this.caps.maxCostUsd !== undefined && this.costUsed + req.estimatedCostUsd > this.caps.maxCostUsd + 1e-9) return { ok: false, reason: "cap_reached" };
    this.requestsUsed += 1;
    this.costUsed += req.estimatedCostUsd;
    return { ok: true };
  }
}
