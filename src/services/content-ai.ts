/** Server entry point for AI-assisted content drafts. The ONLY place that decides whether AI may run for a request.
 *  AI runs only for a signed-in user of a LIVE organisation, with AI_ENABLED=true, prices configured and an API key present.
 *  The public demo (AUTH_MODE=demo) and demo organisations always get the template generator: no key is read, no network call is made. */
import { isLive } from "@/lib/auth/access";
import { getAuthUser } from "@/lib/auth/session";
import { readAiConfig, unavailableReason } from "@/lib/ai/config";
import { CallRateLimiter } from "@/lib/ai/limits";
import { getOpenAiTransport, type OpenAiTransport } from "@/lib/ai/transport";
import { runContentAgent, type RunResult, type ContentRunInput } from "@/lib/content-agent";
import { runContentAgentAi } from "@/lib/content-agent/ai";
import type { StudioDeps } from "@/lib/content-studio/generate";
import type { ContentPack, ContentProduct } from "@/types/content-agent";
import { liveAiLedger } from "./ai-ledger";

const g = globalThis as unknown as { __aiLimiter?: { limit: number; limiter: CallRateLimiter } };

function sharedLimiter(limit: number): CallRateLimiter {
  if (!g.__aiLimiter || g.__aiLimiter.limit !== limit) g.__aiLimiter = { limit, limiter: new CallRateLimiter(limit) };
  return g.__aiLimiter.limiter;
}

/** Test seam: lets a test supply a fake transport. Production never sets it. */
let transportOverride: OpenAiTransport | null | undefined;
export const __setAiTransportForTests = (t: OpenAiTransport | null | undefined) => { transportOverride = t; };

/** The Content Studio's AI dependencies, or null when AI may not run for this request (not a live organisation, AI off, or prices missing).
 *  Same gates as runContentDraft. A null transport means no API key: the generator then uses its template. */
export async function aiRuntime(): Promise<StudioDeps | null> {
  const user = await getAuthUser();
  if (!isLive(user) || !user) return null;
  const config = readAiConfig();
  if (unavailableReason(config) !== null) return null;
  const transport = transportOverride !== undefined ? transportOverride : getOpenAiTransport();
  return { config, transport, ledger: liveAiLedger, limiter: sharedLimiter(config.perUserPerMinute), userKey: user.id };
}

export async function runContentDraft(input: ContentRunInput, products: ContentProduct[], packs: ContentPack[]): Promise<RunResult> {
  const user = await getAuthUser();
  if (!isLive(user) || !user) return runContentAgent(input, products, packs);
  const config = readAiConfig();
  if (unavailableReason(config) !== null) return runContentAgent(input, products, packs);
  const transport = transportOverride !== undefined ? transportOverride : getOpenAiTransport();
  return runContentAgentAi(input, products, packs, { config, transport, ledger: liveAiLedger, limiter: sharedLimiter(config.perUserPerMinute), userKey: user.id });
}

/** Whether AI-written parts sent back on submit may be used: same gates as running AI, minus the key (no model call is made). */
export async function aiPartsAllowed(): Promise<{ allowed: boolean; model: string }> {
  const config = readAiConfig();
  const user = await getAuthUser();
  return { allowed: isLive(user) && unavailableReason(config) === null, model: config.model };
}
