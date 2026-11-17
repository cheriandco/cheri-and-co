/** Server-side AI configuration. EVERYTHING IS OFF BY DEFAULT: AI runs only when AI_ENABLED is exactly "true".
 *  This module reads settings only. It never reads, returns or logs the API key (see transport.ts, the only reader).
 *  Prices are deliberately NOT defaulted: the spend cap cannot be enforced without them, so AI stays off until they are set. */

/** Chosen by the owner. Always overridable with OPENAI_MODEL. Not verified against the live API (no call has been made). */
export const DEFAULT_MODEL = "gpt-6-sol";

export interface AiConfig {
  enabled: boolean;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Organisation-wide ceiling on the estimated spend per calendar month (UTC), in US dollars. */
  monthlyBudgetUsd: number;
  /** Organisation-wide ceiling on calls per UTC day. */
  dailyCallsPerOrg: number;
  perUserPerMinute: number;
  /** US dollars per million tokens. null = not configured. */
  priceInPerMTok: number | null;
  priceOutPerMTok: number | null;
}

export type UnavailableReason = "disabled" | "pricing_not_configured";

type Env = Record<string, string | undefined>;

/** Parses a number inside [min, max]; anything else (missing, NaN, out of range) falls back to the default. */
function num(v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const price = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : null;
};

export function readAiConfig(env: Env = process.env): AiConfig {
  const model = env.OPENAI_MODEL?.trim();
  return {
    enabled: env.AI_ENABLED === "true",
    model: model && /^[A-Za-z0-9._:-]{1,64}$/.test(model) ? model : DEFAULT_MODEL,
    maxOutputTokens: Math.round(num(env.AI_MAX_OUTPUT_TOKENS, 1500, 200, 4000)),
    timeoutMs: Math.round(num(env.AI_TIMEOUT_MS, 30_000, 5_000, 60_000)),
    monthlyBudgetUsd: num(env.AI_MONTHLY_BUDGET_USD, 20, 0, 1000),
    dailyCallsPerOrg: Math.round(num(env.AI_DAILY_CALLS_PER_ORG, 100, 0, 10_000)),
    perUserPerMinute: Math.round(num(env.AI_CALLS_PER_USER_PER_MINUTE, 5, 1, 60)),
    priceInPerMTok: price(env.OPENAI_PRICE_INPUT_USD_PER_MTOK),
    priceOutPerMTok: price(env.OPENAI_PRICE_OUTPUT_USD_PER_MTOK),
  };
}

/** Null when AI may be attempted; otherwise why not. Pure: no network, no key. */
export function unavailableReason(cfg: AiConfig): UnavailableReason | null {
  if (!cfg.enabled) return "disabled";
  if (cfg.priceInPerMTok === null || cfg.priceOutPerMTok === null) return "pricing_not_configured";
  return null;
}
