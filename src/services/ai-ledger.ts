/** The AI usage ledger over the signed-in user's own organisation (rows in agent_activity; see src/lib/ai/limits.ts). */
import type { AiLedger } from "@/lib/ai/limits";
import { liveAiRecord, liveAiUsage } from "./live";

export const liveAiLedger: AiLedger = { usage: liveAiUsage, record: liveAiRecord };
