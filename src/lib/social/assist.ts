/** "AI assistance" for the social media demo. Deterministic templates only: NO AI model is called, no network is
 *  used, no key is read. Every result carries a label saying so. Output is scanned by the same claim guard as drafts. */
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { str } from "@/lib/validate";
import { LIMITS, isPlatform, normalizeHashtags } from "./posts";
import type { AssistMode, AssistResult, SocialPlatform } from "@/types/social";

export const ASSIST_LABEL = "DEMO RESPONSE · template-based. No AI model is connected.";
const MODES: AssistMode[] = ["ideas", "caption", "brief"];

const pick = <T,>(items: T[], seed: string, offset = 0): T => {
  let h = offset;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return items[h % items.length];
};

const TONE: Record<SocialPlatform, { hook: string[]; close: string; tags: string[] }> = {
  Instagram: { hook: ["Small details, big difference.", "Your everyday, elevated.", "Soft light, simple pieces."], close: "Tell us your favourite in the comments.", tags: ["#CheriAndCo", "#MinimalJewellery", "#KoreanInspired"] },
  Facebook: { hook: ["Here is something we have been excited to share.", "A little idea for your week.", "Meet a simple everyday pick."], close: "Share it with a friend who would love it.", tags: ["#CheriAndCo", "#JewelleryIdeas"] },
  LinkedIn: { hook: ["A note for our retail partners.", "How we think about curating a range.", "Behind the scenes of our process."], close: "Message us to talk about how this could work for your store.", tags: ["#CheriAndCo", "#Retail", "#Wholesale"] },
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const sentence = (s: string) => { const t = clean(s); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : ""; };

function ideas(topic: string, platform: SocialPlatform): string[] {
  const t = topic || "our latest pieces";
  const formats: Record<SocialPlatform, string[]> = {
    Instagram: [`A 15-second reel: three ways to wear ${t}.`, `A carousel: ${t}, from first look to final styling.`, `A story set with a poll asking which look people prefer for ${t}.`],
    Facebook: [`A short post: the story behind ${t}, with one clear photo.`, `A gifting idea built around ${t}, for friends and family.`, `A weekend styling note featuring ${t}.`],
    LinkedIn: [`A short article: how we curate ${t} for retail partners.`, `A carousel of our 2, 3, 6 and 10 piece packs, framed around ${t}.`, `A behind-the-scenes post on how ${t} is chosen and packed.`],
  };
  return formats[platform];
}

function caption(topic: string, platform: SocialPlatform, existing: string): string[] {
  const tone = TONE[platform];
  const base = existing ? sentence(existing) : sentence(topic || "our latest pieces");
  const hook = pick(tone.hook, topic + existing);
  return [
    `${hook} ${base} ${tone.close}`,
    `${base} ${tone.close}`,
    `${hook} ${base}`,
  ].map(clean);
}

function brief(topic: string, platform: SocialPlatform): string[] {
  const t = topic || "the featured pieces";
  const shape = platform === "Instagram" ? "Vertical 9:16 for reels and stories, 4:5 for the feed" : platform === "Facebook" ? "Square or 4:5, one clear hero image" : "Clean landscape or square graphic, text kept short and readable";
  return [
    `Creative brief: ${t}. Mood: calm, warm and minimal, in line with the Cheri & Co. look (warm ivory, dusty rose, charcoal). Show the pieces clearly, one idea per frame, nothing cluttered.`,
    `Image direction: ${shape}. Soft natural or warm studio light, plain ivory or pale pink backdrop, close crops of the jewellery, space left for the wordmark.`,
  ];
}

export type AssistParsed = { ok: true; mode: AssistMode; platform: SocialPlatform; topic: string; caption: string } | { ok: false; error: string };

export function parseAssistInput(body: Record<string, unknown> | null): AssistParsed {
  if (!body) return { ok: false, error: "Invalid request." };
  if (!MODES.includes(body.mode as AssistMode)) return { ok: false, error: "Choose ideas, caption or brief." };
  if (!isPlatform(body.platform)) return { ok: false, error: "Choose Instagram, Facebook or LinkedIn." };
  const topic = body.topic === undefined || body.topic === "" ? "" : str(body.topic, LIMITS.topic);
  const cap = body.caption === undefined || body.caption === "" ? "" : str(body.caption, LIMITS.caption);
  if (topic === null) return { ok: false, error: `Topic is too long (max ${LIMITS.topic}).` };
  if (cap === null) return { ok: false, error: `Caption is too long (max ${LIMITS.caption}).` };
  if (!topic && !cap) return { ok: false, error: "Add a topic or a caption first, so the demo has something to work from." };
  return { ok: true, mode: body.mode as AssistMode, platform: body.platform, topic, caption: cap };
}

export function runAssist(input: { mode: AssistMode; platform: SocialPlatform; topic: string; caption: string }): AssistResult {
  const suggestions = input.mode === "ideas" ? ideas(input.topic, input.platform)
    : input.mode === "caption" ? caption(input.topic, input.platform, input.caption)
    : brief(input.topic, input.platform);
  const warnings = [...new Set(findProhibitedClaims(`${input.topic}\n${input.caption}\n${suggestions.join("\n")}`, []).map((v) => `${v.label}: "${v.match}"`))];
  return { mode: input.mode, label: ASSIST_LABEL, suggestions, hashtags: normalizeHashtags(TONE[input.platform].tags), warnings };
}
