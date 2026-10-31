import type { ContentDraft } from "@/types/content-agent";

export const MAX_PREVIEW_LENGTH = 6000;

/** Plain-text version of a draft, used as the approval preview so a reviewer sees everything that would be used. */
export function renderDraft(d: ContentDraft): string {
  const notes = d.issues.filter((i) => i.severity !== "info");
  const out: string[] = [];
  if (d.subject.isSample) out.push("[SAMPLE DATA · NOT FOR PUBLISHING]", "");
  out.push("INSTAGRAM CAPTION", d.instagramCaption, "");
  out.push(`REEL SCRIPT (${d.reelScript.durationSeconds}s)`, ...d.reelScript.scenes.map((s) => `${s.time}: ${s.visual}${s.onScreenText ? ` | on-screen: ${s.onScreenText}` : ""}`), `Audio: ${d.reelScript.audioNote}`, "");
  out.push(`ASMR SCRIPT (${d.asmrScript.durationSeconds}s)`, ...d.asmrScript.cues.map((c) => `${c.time}: ${c.visual} | sound: ${c.sound}`), d.asmrScript.note, "");
  out.push("STORY", ...d.story.map((f) => `Frame ${f.frame}: ${f.visual} | text: ${f.text}${f.sticker ? ` | ${f.sticker}` : ""}`), "");
  const b = d.canvaBrief;
  out.push("CANVA BRIEF", `Formats: ${b.formats.map((f) => `${f.name} ${f.size}`).join("; ")}`, `Headline: ${b.headline}`, `Supporting text: ${b.supportingText}`,
    `Layout: ${b.layout}`, `Palette: ${b.palette}`, `Imagery: ${b.imagery}`, `Avoid: ${b.avoid.join("; ")}`);
  if (notes.length) out.push("", "REVIEW NOTES", ...notes.map((n) => `- ${n.message}`));
  return out.join("\n");
}
