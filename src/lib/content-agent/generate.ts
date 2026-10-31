/** Template-based content generator. Pure: no network, no environment, no storage, no publishing.
 *  It writes only from the fields of the supplied record. Anything missing is reported, never invented. */
import type {
  Audience, ContentCategory, ContentDraft, ContentIssue, ContentSubject, MarketplaceCta, StoryFrame,
} from "@/types/content-agent";
import { AUDIENCE_HASHTAG, BASE_HASHTAGS, BRAND_SIGNATURE, HOOKS, MAX_CAPTION_LENGTH, PALETTE_NOTE } from "./brand";
import { findProhibitedClaims } from "./claims";
import { checkMarketplaceLink } from "./links";
import { CATEGORY_LABEL } from "./subjects";

export interface GenerateOptions { audience?: Audience }

const HASHTAG_FOR: Record<ContentCategory, string> = {
  bracelet: "Bracelets", chain_pendant: "ChainPendant", earrings: "Earrings", chain: "Chains",
  ring: "Rings", hair_accessory: "HairAccessories", watch_combo: "WatchCombo",
};

const MISSING_AMAZON = "[Amazon link not supplied]";
const MISSING_FLIPKART = "[Flipkart link not supplied]";

function resolveLinks(subject: ContentSubject, issues: ContentIssue[]): MarketplaceCta {
  const one = (market: "amazon" | "flipkart", missing: string, label: string) => {
    const raw = subject.links[market];
    if (raw) {
      const res = checkMarketplaceLink(market, raw);
      if (res.ok) return { supplied: true, line: `Shop on ${label}: ${res.url}` };
      issues.push({ severity: "error", code: "invalid_marketplace_link", message: res.reason });
    } else {
      issues.push({ severity: "warning", code: "missing_marketplace_link", message: `No ${label} link supplied. Add it before this is used.` });
    }
    return { supplied: false, line: `Shop on ${label}: ${missing}` };
  };
  return { amazon: one("amazon", MISSING_AMAZON, "Amazon"), flipkart: one("flipkart", MISSING_FLIPKART, "Flipkart") };
}

const countBy = (cats: ContentCategory[]) => {
  const counts = new Map<ContentCategory, number>();
  for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${n} × ${n === 1 ? CATEGORY_LABEL[c].singular : CATEGORY_LABEL[c].plural}`).join(", ");
};

const marketNames = (cta: MarketplaceCta) => [cta.amazon.supplied && "Amazon", cta.flipkart.supplied && "Flipkart"].filter(Boolean).join(" & ");

function hashtags(subject: ContentSubject, audience: Audience): string[] {
  const tags = [...BASE_HASHTAGS, AUDIENCE_HASHTAG[audience], ...(subject.kind === "pack" ? ["JewelleryCombo"] : []),
    ...subject.categories.map((c) => HASHTAG_FOR[c])];
  return [...new Set(tags)].slice(0, 8).map((t) => `#${t}`);
}

function caption(s: ContentSubject, name: string, audience: Audience, cta: MarketplaceCta, tags: string[]): string {
  const lines: string[] = [HOOKS[audience]];
  lines.push(s.kind === "pack" ? `Meet the ${name}: ${s.pieceCount} pieces, one curated combo.` : `Meet the ${name}.`);
  if (s.kind === "pack" && s.memberCategories.length) lines.push(`Inside: ${countBy(s.memberCategories)}.`);
  if (s.styleTags.length) lines.push(`Style: ${s.styleTags.join(" · ")}.`);
  if (s.materialNote) lines.push(`Material: ${s.materialNote}`);
  for (const c of s.approvedClaims.slice(0, 3)) lines.push(`• ${c}`);
  if (s.packaging === "pinterest_paper_box") lines.push("Packed in a Pinterest-inspired paper box.");
  lines.push("", cta.amazon.line, cta.flipkart.line, "", BRAND_SIGNATURE, tags.join(" "));
  return lines.join("\n");
}

function reel(s: ContentSubject, name: string, audience: Audience, cta: MarketplaceCta) {
  const pack = s.kind === "pack";
  const worn: Record<Audience, string> = {
    everyday: "Worn in a simple everyday moment",
    college: "Worn with a casual campus outfit",
    work: "Worn with a clean workday outfit",
    gifting: s.packaging === "pinterest_paper_box" ? "Piece placed in the paper box, lid closing" : "Flat lay of the piece(s) on a plain card",
  };
  const endText = marketNames(cta) ? `Shop on ${marketNames(cta)}: link in bio` : "[Add a marketplace link before publishing]";
  return {
    title: `Reel · ${name}`, durationSeconds: 18,
    scenes: [
      { time: "0–3s", visual: `Close-up of the ${name} on a clean, softly lit surface`, onScreenText: HOOKS[audience] },
      { time: "3–8s", visual: pack ? `Show each of the ${s.pieceCount} pieces in turn, one beat per piece` : `Slow reveal of the ${name}, one gentle camera move`, onScreenText: pack ? `${s.pieceCount} pieces · one set` : name },
      { time: "8–13s", visual: worn[audience], onScreenText: "" },
      { time: "13–18s", visual: "End card with the Cheri & Co. logo", onScreenText: endText },
    ],
    audioNote: "Soft instrumental track. Licensed audio to be chosen by the team; do not use unlicensed music.",
  };
}

function asmr(s: ContentSubject, name: string) {
  const pack = s.kind === "pack";
  const boxed = s.packaging === "pinterest_paper_box";
  return {
    title: `ASMR · ${name}`, durationSeconds: 20,
    cues: [
      { time: "0–4s", visual: `Overhead shot of a clean surface with the ${pack ? "pieces" : "piece"} laid out`, sound: "Quiet room tone, slow fingertip taps on the surface" },
      { time: "4–10s", visual: pack ? "Pick up and set down each piece in turn, slow and unhurried" : `Fingertips slowly pick up and set down the ${name}`, sound: "Soft, close-mic movement sounds" },
      { time: "10–16s", visual: boxed ? "Lid lifting off the paper box, piece(s) placed inside" : "Piece(s) arranged on a plain card, slow top-down push-in", sound: boxed ? "Paper rustle and lid sounds" : "Gentle cloth and tabletop sounds" },
      { time: "16–20s", visual: "End card with the Cheri & Co. logo", sound: "A single soft tap" },
    ],
    note: "Record real sounds on set. Keep voiceover off, or whisper only the name. No claims about the piece are spoken.",
  };
}

function story(s: ContentSubject, name: string, audience: Audience, cta: MarketplaceCta): StoryFrame[] {
  return [
    { frame: 1, visual: `Teaser close-up of the ${name}`, text: HOOKS[audience] },
    { frame: 2, visual: s.kind === "pack" ? `All ${s.pieceCount} pieces laid out together` : "The piece on a plain background", text: s.kind === "pack" ? `${name} · ${s.pieceCount} pieces` : name },
    { frame: 3, visual: "Link frame on a soft brand colour", text: "Tap to shop",
      sticker: `Link sticker. ${cta.amazon.line}. ${cta.flipkart.line}.` },
  ];
}

function canva(s: ContentSubject, name: string) {
  const pack = s.kind === "pack";
  return {
    formats: [{ name: "Instagram post", size: "1080 × 1350" }, { name: "Reel cover and Story", size: "1080 × 1920" }],
    headline: pack ? `${name} · ${s.pieceCount}-piece combo` : name,
    supportingText: BRAND_SIGNATURE,
    layout: pack ? `Flat lay of all ${s.pieceCount} pieces with generous space around them, logo bottom-centre.` : "One hero piece with generous space around it, logo bottom-centre.",
    palette: PALETTE_NOTE,
    imagery: "Use client-supplied product photos only. None are attached to this draft.",
    avoid: ["Money amounts or badges about savings", "Wording about how many are left", "Material, plating or durability wording unless client-approved", "Unlicensed music or stock images"],
  };
}

function facts(s: ContentSubject, cta: MarketplaceCta): string[] {
  return [
    `Name: ${s.name || "not supplied"}`, `Pieces: ${s.pieceCount}`,
    `Categories: ${s.categories.length ? s.categories.map((c) => CATEGORY_LABEL[c].plural).join(", ") : "not supplied"}`,
    `Style tags: ${s.styleTags.length ? s.styleTags.join(", ") : "not supplied"}`,
    `Material: ${s.materialNote ?? "not supplied (not mentioned)"}`,
    `Approved claims: ${s.approvedClaims.length}`,
    `Packaging: ${s.packaging === "pinterest_paper_box" ? "Pinterest-inspired paper box" : "not specified (not mentioned)"}`,
    `Amazon link: ${cta.amazon.supplied ? "supplied" : "not supplied"}`, `Flipkart link: ${cta.flipkart.supplied ? "supplied" : "not supplied"}`,
  ];
}

/** Every piece of generated copy as one string, used by the claim guard. Excludes review notes and banners. */
export function copyText(d: Pick<ContentDraft, "instagramCaption" | "hashtags" | "reelScript" | "asmrScript" | "story" | "canvaBrief">): string {
  return [
    d.instagramCaption, d.hashtags.join(" "), d.reelScript.title, ...d.reelScript.scenes.flatMap((x) => [x.visual, x.onScreenText]), d.reelScript.audioNote,
    d.asmrScript.title, ...d.asmrScript.cues.flatMap((x) => [x.visual, x.sound]), d.asmrScript.note,
    ...d.story.flatMap((x) => [x.visual, x.text, x.sticker ?? ""]),
    ...d.canvaBrief.formats.map((f) => f.name), d.canvaBrief.headline, d.canvaBrief.supportingText, d.canvaBrief.layout, d.canvaBrief.imagery, ...d.canvaBrief.avoid,
  ].join("\n");
}

export function generateContent(subject: ContentSubject, options: GenerateOptions = {}): ContentDraft {
  const audience = options.audience ?? "everyday";
  const issues: ContentIssue[] = [];
  const name = subject.name.trim() || "[name missing]";
  if (!subject.name.trim()) issues.push({ severity: "error", code: "empty_name", message: "The product or pack has no name." });
  if (subject.isSample) issues.push({ severity: "warning", code: "sample_data", message: "SAMPLE data: do not publish this." });
  if (!subject.categories.length) issues.push({ severity: "warning", code: "missing_category", message: "No category supplied; the draft says \"piece\" and nothing more specific." });
  if (!subject.styleTags.length) issues.push({ severity: "warning", code: "missing_style", message: "No style tags supplied; the style line is left out." });
  if (!subject.materialNote) issues.push({ severity: "info", code: "missing_material", message: "No material wording supplied; none is used." });
  if (!subject.approvedClaims.length) issues.push({ severity: "info", code: "no_approved_claims", message: "No client-approved claims supplied; the draft makes none." });

  const cta = resolveLinks(subject, issues);
  const tags = hashtags(subject, audience);
  const draft: ContentDraft = {
    status: "ai_generated",
    subject: { name, kind: subject.kind, pieceCount: subject.pieceCount, isSample: subject.isSample },
    audience, instagramCaption: caption(subject, name, audience, cta, tags), hashtags: tags,
    reelScript: reel(subject, name, audience, cta), asmrScript: asmr(subject, name), story: story(subject, name, audience, cta),
    canvaBrief: canva(subject, name), cta, issues, blocked: false, factsUsed: facts(subject, cta),
    published: false, generator: "template",
    dataSource: { verified: false, note: "Template-generated from the supplied record only. Nothing is published, sent or stored." },
  };

  if (draft.instagramCaption.length > MAX_CAPTION_LENGTH)
    issues.push({ severity: "error", code: "caption_too_long", message: `Caption is longer than ${MAX_CAPTION_LENGTH} characters.` });
  const seen = new Set<string>();
  for (const v of findProhibitedClaims(copyText(draft), subject.approvedClaims)) {
    const key = `${v.rule}:${v.match.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ severity: "error", code: "prohibited_claim", message: `Blocked ${v.label} wording: "${v.match}". Only client-approved claims may be used.` });
  }
  draft.blocked = issues.some((i) => i.severity === "error");
  return draft;
}
