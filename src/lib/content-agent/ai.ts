/** AI-assisted drafting for the Content & Marketing Agent (pilot). The model writes ONLY the text parts (caption body, three reel
 *  on-screen lines, two story lines, one Canva headline). Everything else is code: structure, links, hashtags, approved claims,
 *  the brand line, the review notes. The assembled draft then goes through the SAME claim guard as template drafts.
 *
 *  Safety rules, in order:
 *   1. Never for the public demo or a signed-out visitor (the caller only passes a live organisation).
 *   2. Never when the template draft already has an error (no money spent on a draft that cannot be used).
 *   3. Reserve spend first (limits.ts). Refused or failed AI falls back to the template draft with a plain-language note.
 *   4. AI text with links, hashtags, handles or personal data is rejected; text with prohibited claims is DISCARDED, not edited.
 *   5. The result is still only a draft. Submitting it creates a pending approval; a person must approve it. Nothing is published. */
import type { ContentAiParts, ContentDraft, ContentPack, ContentProduct, ContentSubject } from "@/types/content-agent";
import { callStructured, describeAiError } from "@/lib/ai/client";
import { unavailableReason, type AiConfig } from "@/lib/ai/config";
import { describeRefusal, reserveAiCall, type AiLedger, type CallRateLimiter } from "@/lib/ai/limits";
import type { OpenAiTransport } from "@/lib/ai/transport";
import { BRAND_SIGNATURE } from "./brand";
import { applyGuards, generateContent } from "./generate";
import { CONTENT_INSTRUCTIONS, CONTENT_PROMPT_VERSION, CONTENT_SCHEMA, CONTENT_SCHEMA_NAME, buildContentInput, parseContentAiOutput } from "./ai-prompt";
import { subjectFor, type ContentRunInput, type RunResult } from "./index";

export interface ContentAiDeps {
  config: AiConfig;
  /** Null when no API key is configured: the template is used. */
  transport: OpenAiTransport | null;
  ledger: AiLedger;
  limiter: CallRateLimiter;
  userKey: string;
  now?: () => Date;
}

const AI_REVIEW_NOTE = "AI-written text: check every line against the product before approving.";
const AI_DATA_NOTE = "Text written by an AI model from the supplied record only, then checked by the claim guard. A person must approve it. Nothing is published, sent or stored.";

/** Replaces the text parts of a template draft with AI-written ones and re-runs the guards. Pure; makes no network call. */
export function assembleAiDraft(base: ContentDraft, subject: ContentSubject, parts: ContentAiParts, meta: { model: string; redactions: number }): ContentDraft {
  const d: ContentDraft = structuredClone(base);
  const claims = subject.approvedClaims.slice(0, 3).map((c) => `• ${c}`);
  d.instagramCaption = [parts.caption, ...claims, "", d.cta.amazon.line, d.cta.flipkart.line, "", BRAND_SIGNATURE, d.hashtags.join(" ")].join("\n");
  d.reelScript.scenes.slice(0, 3).forEach((s, i) => { s.onScreenText = parts.reelOnScreen[i]; });
  d.story.slice(0, 2).forEach((f, i) => { f.text = parts.storyText[i]; });
  d.canvaBrief.headline = parts.canvaHeadline;
  d.generator = "openai";
  d.ai = { model: meta.model, promptVersion: CONTENT_PROMPT_VERSION, redactions: meta.redactions, parts };
  d.dataSource = { verified: false, note: AI_DATA_NOTE };
  // Recompute the guard issues from scratch for the new copy, then add the reviewer's reminder.
  d.issues = d.issues.filter((i) => i.code !== "prohibited_claim" && i.code !== "caption_too_long");
  d.issues.push({ severity: "warning", code: "ai_generated", message: AI_REVIEW_NOTE });
  return applyGuards(d, subject);
}

const guardFailed = (d: ContentDraft) => d.issues.some((i) => i.severity === "error" && (i.code === "prohibited_claim" || i.code === "caption_too_long"));

/** Rebuilds an AI draft from parts the browser sent back on submit. Makes NO model call and costs nothing; the parts are validated
 *  by the caller's parser and re-guarded here, so nothing the browser sends skips the claim guard. */
export function runContentAgentFromParts(input: ContentRunInput, products: ContentProduct[], packs: ContentPack[], model: string): RunResult {
  const resolved = subjectFor(input, products, packs);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (!input.aiParts) return { ok: false, error: "No AI-written text to rebuild." };
  const base = generateContent(resolved.subject, { audience: input.audience });
  return { ok: true, draft: assembleAiDraft(base, resolved.subject, input.aiParts, { model, redactions: 0 }) };
}

const fallback = (base: Extract<RunResult, { ok: true }>, why: string): RunResult => ({ ok: true, draft: base.draft, note: `${why}, so the template draft was used. ${base.note ?? ""}`.trim() });

export async function runContentAgentAi(input: ContentRunInput, products: ContentProduct[], packs: ContentPack[], deps: ContentAiDeps): Promise<RunResult> {
  const resolved = subjectFor(input, products, packs);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const subject = resolved.subject;
  const base = generateContent(subject, { audience: input.audience });
  const templateRun: Extract<RunResult, { ok: true }> = { ok: true, draft: base };

  if (unavailableReason(deps.config) !== null) return templateRun; // off by default: behaves exactly as before
  if (!deps.transport) return fallback(templateRun, "AI drafting is switched on but not configured on the server");
  if (base.blocked) return templateRun; // already unusable (for example an invalid link): do not spend on it

  const { input: userInput, redactions } = buildContentInput(subject, input.audience);
  const reserved = await reserveAiCall({
    ledger: deps.ledger, config: deps.config, limiter: deps.limiter, userKey: deps.userKey, agent: "content",
    inputChars: CONTENT_INSTRUCTIONS.length + userInput.length, now: deps.now?.(),
  });
  if (!reserved.ok) return fallback(templateRun, describeRefusal(reserved.reason));

  const result = await callStructured<ContentAiParts>({
    transport: deps.transport, config: deps.config, instructions: CONTENT_INSTRUCTIONS, input: userInput,
    schemaName: CONTENT_SCHEMA_NAME, schema: CONTENT_SCHEMA, validate: parseContentAiOutput,
  });
  if (!result.ok) return fallback(templateRun, `AI drafting failed (${describeAiError(result.code)}) and this attempt counted toward the usage limits`);

  const draft = assembleAiDraft(base, subject, result.data, { model: result.model, redactions });
  if (guardFailed(draft)) return fallback(templateRun, "The AI draft was discarded because it contained wording that needs client-approved claims");
  return { ok: true, draft, note: "Written by AI. A person must review and approve it; nothing is published." };
}
