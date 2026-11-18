/** Content Studio generator: product + kind -> a SocialPostInput (a draft). Pure apart from the injected AI transport and ledger.
 *  Order of safety: the model writes only the copy text; code builds the title, hashtags, brand line, image reference and review notes;
 *  the assembled text goes through the same claim guard as every other draft (no approved claims exist for live products, so any price, offer,
 *  stock, material, certification, superlative or health wording is a violation). AI text that fails the guard is DISCARDED, never edited.
 *  Any refusal or failure falls back to a deterministic template, with a plain note. Nothing here publishes, sends or stores anything. */
import { callStructured, describeAiError } from "@/lib/ai/client";
import { unavailableReason, type AiConfig } from "@/lib/ai/config";
import { describeRefusal, reserveAiCall, type AiLedger, type CallRateLimiter } from "@/lib/ai/limits";
import type { OpenAiTransport } from "@/lib/ai/transport";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { normalizeHashtags } from "@/lib/social/posts";
import type { Audience } from "@/types/content-agent";
import type { SocialPostInput } from "@/types/social";
import { AUDIENCE_TAG, BASE_TAGS, BRAND_SIGNATURE } from "./brand-brain";
import { KIND_META, type StudioKind } from "./kinds";
import { STUDIO_PROMPT_VERSION, STUDIO_SCHEMA, STUDIO_SCHEMA_NAME, buildStudioInput, parseStudioOutput, studioInstructions, type StudioCopy } from "./prompt";

export interface StudioProduct { id: string; name: string; category: string; description: string | null; imageUrl: string | null }
export interface StudioRequest { product: StudioProduct; kind: StudioKind; audience: Audience; theme?: string }

export interface StudioDeps {
  config: AiConfig;
  /** Null when no API key is configured: the template is used. */
  transport: OpenAiTransport | null;
  ledger: AiLedger;
  limiter: CallRateLimiter;
  userKey: string;
  now?: () => Date;
}

export interface StudioOutcome {
  post: SocialPostInput;
  generator: "openai" | "template";
  model?: string;
  promptVersion?: string;
  redactions: number;
  /** Plain-language note for the user (why a template was used, or the review reminder). */
  note: string;
}

const REVIEW_NOTE = "Written by AI from the product record and the Brand Brain. Check every line before sending it for approval; nothing is posted.";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Sentences of the owner's description, for the template. Kept short: at most two. */
const sentences = (text: string | null): string[] => (text ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 2);

/** Deterministic copy used when AI is off, refused or failed. Uses only the product's own name, category and description. */
export function templateCopy(req: StudioRequest, withDescription = true): StudioCopy {
  const { product: p, kind, audience } = req;
  const facts = withDescription ? sentences(p.description).join(" ") : "";
  const cat = p.category ? ` (${p.category.toLowerCase()})` : "";
  const hook: Record<Audience, string> = {
    everyday: "Small details, everyday style.", college: "Your college look, made simple.", work: "Quietly polished for the workday.", gifting: "A gift that feels thoughtfully picked.",
  };
  switch (kind) {
    case "product_description": return { headline: "", body: [`${p.name}${cat}.`, facts || "More details to be added."].join(" ") };
    case "campaign_copy": return { headline: clip(p.name, 80), body: [hook[audience], `Meet ${p.name}${cat}.`, facts].filter(Boolean).join("\n\n") };
    case "linkedin_post": return { headline: "", body: [`Introducing ${p.name} from Cheri & Co.${cat ? ` A piece from our ${p.category.toLowerCase()} range.` : ""}`, facts].filter(Boolean).join("\n\n") };
    default: return { headline: "", body: [hook[audience], `${p.name}${cat}.`, facts].filter(Boolean).join("\n\n") };
  }
}

const TAGS: Record<StudioKind, (a: Audience) => string[]> = {
  instagram_caption: (a) => [...BASE_TAGS, AUDIENCE_TAG[a]],
  facebook_post: () => ["#CheriAndCo"],
  linkedin_post: () => [],
  product_description: () => [],
  campaign_copy: () => ["#CheriAndCo"],
};

/** Builds the saved draft from the copy. Code decides every field except the copy text itself. */
export function assemblePost(req: StudioRequest, copy: StudioCopy, generator: "openai" | "template"): SocialPostInput {
  const { product: p, kind, audience } = req;
  const meta = KIND_META[kind];
  const withLine = kind === "product_description" ? copy.body : [kind === "campaign_copy" ? copy.headline : "", copy.body, BRAND_SIGNATURE].filter(Boolean).join("\n\n");
  const refImage = p.imageUrl ? `Reference product image (link on file): ${p.imageUrl}` : "";
  return {
    title: clip(`${meta.label} · ${p.name}`, 120),
    topic: clip(`${generator === "openai" ? "AI" : "Template"} draft · ${meta.label} · ${p.name}`, 200),
    platform: meta.platform,
    caption: clip(withLine, 2200),
    hashtags: normalizeHashtags(TAGS[kind](audience)),
    creativeBrief: clip([`Audience: ${audience}.`, req.theme ? `Campaign note: ${req.theme}` : ""].filter(Boolean).join(" "), 1500),
    imageDirection: refImage && refImage.length <= 800 ? refImage : "",
  };
}

/** The text the claim guard scans: everything a reviewer will read in the copy. */
const guardText = (post: SocialPostInput) => [post.caption, post.hashtags.join(" "), post.creativeBrief].join("\n");
export const guardViolations = (post: SocialPostInput) => findProhibitedClaims(guardText(post), []);

function templateOutcome(req: StudioRequest, note: string, redactions = 0): StudioOutcome {
  // The owner's description can itself contain wording the guard refuses (for example a price or a material). Leave it out rather than ship it.
  let post = assemblePost(req, templateCopy(req), "template");
  let extra = "";
  if (guardViolations(post).length) {
    post = assemblePost(req, templateCopy(req, false), "template");
    extra = " The product description was left out of the template because it contains wording that needs client-approved claims.";
  }
  return { post, generator: "template", redactions, note: `${note}${extra}`.trim() };
}

const OFF_NOTE = "AI drafting is switched off, so a template draft was made from the product record.";

export async function runStudio(req: StudioRequest, deps: StudioDeps | null): Promise<StudioOutcome> {
  if (!deps || unavailableReason(deps.config) !== null) return templateOutcome(req, OFF_NOTE);
  if (!deps.transport) return templateOutcome(req, "AI drafting is switched on but not configured on the server, so a template draft was made.");

  const { input, redactions } = buildStudioInput({ product: req.product, kind: req.kind, audience: req.audience, theme: req.theme });
  const instructions = studioInstructions(req.kind);
  const reserved = await reserveAiCall({
    ledger: deps.ledger, config: deps.config, limiter: deps.limiter, userKey: deps.userKey, agent: "content",
    inputChars: instructions.length + input.length, now: deps.now?.(),
  });
  if (!reserved.ok) return templateOutcome(req, `${describeRefusal(reserved.reason)}, so a template draft was made.`, redactions);

  const result = await callStructured<StudioCopy>({
    transport: deps.transport, config: deps.config, instructions, input, schemaName: STUDIO_SCHEMA_NAME, schema: STUDIO_SCHEMA, validate: parseStudioOutput(req.kind),
  });
  if (!result.ok) return templateOutcome(req, `AI drafting failed (${describeAiError(result.code)}) and this attempt counted toward the usage limits, so a template draft was made.`, redactions);

  const post = assemblePost(req, result.data, "openai");
  if (guardViolations(post).length) {
    return templateOutcome(req, "The AI draft was discarded because it contained wording that needs client-approved claims, so a template draft was made. This attempt counted toward the usage limits.", redactions);
  }
  return { post, generator: "openai", model: result.model, promptVersion: STUDIO_PROMPT_VERSION, redactions, note: REVIEW_NOTE };
}
