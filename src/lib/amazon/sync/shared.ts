import type { ThrottledError } from "../client";
import type { ModuleOutcome } from "./types";

export const DEFAULT_PAGES_PER_STEP = 3;
export const FIRST_LOOKBACK_DAYS = 30;
/** Amazon requires lastUpdatedBefore to be at least two minutes in the past; five leaves margin for clock drift. */
export const ORDERS_END_LAG_MS = 5 * 60_000;

export const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A rate limit is not a failure: the sync keeps its place and says when to come back. */
export function waiting(e: ThrottledError, cursor: Record<string, unknown>, counts: Record<string, number>): ModuleOutcome {
  return { status: "waiting", cursor, counts, retryAfterMs: e.retryAfterMs, message: e.message };
}

export function bump(counts: Record<string, number>, key: string, by: number): void { counts[key] = (counts[key] ?? 0) + by; }
