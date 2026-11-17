import { AUDIENCES } from "@/types/content-agent";
import type { Audience, ContentAiParts, ContentDraft, ContentPack, ContentProduct, ContentSubject, ContentTarget } from "@/types/content-agent";
import { str } from "@/lib/validate";
import { chooseGenerator } from "./config";
import { validateContentAiParts } from "./ai-prompt";
import { generateContent } from "./generate";
import { MAX_LINK_LENGTH } from "./links";
import { resolveSubject } from "./subjects";

export interface ContentRunInput {
  target: ContentTarget;
  audience: Audience;
  /** Links supplied for this run. They take precedence over links stored on the record. */
  links: { amazon?: string; flipkart?: string };
  /** AI-written text parts sent back by the browser on submit. Always re-validated and re-guarded on the server; ignored unless AI is allowed. */
  aiParts?: ContentAiParts;
}

export type ParseResult = { ok: true; input: ContentRunInput } | { ok: false; error: string };

/** Validates the JSON body shared by the run and submit routes. */
export function parseRunInput(body: Record<string, unknown> | null): ParseResult {
  const type = body?.targetType;
  const id = str(body?.targetId, 100);
  if ((type !== "product" && type !== "pack") || !id) return { ok: false, error: "Choose a product or pack." };
  const audience = body?.audience ?? "everyday";
  if (typeof audience !== "string" || !(AUDIENCES as string[]).includes(audience)) return { ok: false, error: "Unknown audience." };
  const links: ContentRunInput["links"] = {};
  for (const key of ["amazon", "flipkart"] as const) {
    const raw = body?.[`${key}Url`];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = str(raw, MAX_LINK_LENGTH);
    if (!v) return { ok: false, error: `The ${key} link is empty or too long.` };
    links[key] = v;
  }
  const input: ContentRunInput = { target: { type, id }, audience: audience as Audience, links };
  if (body?.aiParts !== undefined && body.aiParts !== null) {
    const parts = validateContentAiParts(body.aiParts);
    if (!parts) return { ok: false, error: "The AI-written text did not pass the safety checks." };
    input.aiParts = parts;
  }
  return { ok: true, input };
}

/** Resolves the record and merges the links supplied for this run. Shared by the template and AI paths. */
export function subjectFor(input: ContentRunInput, products: ContentProduct[], packs: ContentPack[]): { ok: true; subject: ContentSubject } | { ok: false; error: string } {
  const resolved = resolveSubject(input.target, products, packs);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, subject: { ...resolved.subject, links: { ...resolved.subject.links, ...input.links } } };
}

export type RunResult = { ok: true; draft: ContentDraft; note?: string } | { ok: false; error: string };

/** Builds a draft for one product or pack. Never stores, sends or publishes anything. */
export function runContentAgent(input: ContentRunInput, products: ContentProduct[], packs: ContentPack[]): RunResult {
  const resolved = subjectFor(input, products, packs);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const choice = chooseGenerator();
  return { ok: true, draft: generateContent(resolved.subject, { audience: input.audience }), note: choice.note };
}
