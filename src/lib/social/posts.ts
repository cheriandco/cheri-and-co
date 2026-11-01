/** Pure helpers for the social media demo: input validation, approval text, status, calendar and sample metrics.
 *  No I/O. Nothing here posts, sends or stores anything. */
import { str } from "@/lib/validate";
import { SOCIAL_PLATFORMS, type SocialMetrics, type SocialPlatform, type SocialPost, type SocialPostInput, type SocialPostView, type SocialStatus } from "@/types/social";
import type { ApprovalStatus } from "@/types";

export const LIMITS = { title: 120, topic: 200, caption: 2200, brief: 1500, image: 800, tags: 30, tag: 40 } as const;

export const isPlatform = (v: unknown): v is SocialPlatform => typeof v === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Accepts "#a #b", "a, b" or an array; returns clean #tags (letters, digits, underscore), de-duplicated and capped. */
export function normalizeHashtags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.filter((x): x is string => typeof x === "string") : typeof input === "string" ? input.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const r of raw) {
    const word = r.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!word || word.length > LIMITS.tag) continue;
    const tag = `#${word}`;
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

const optional = (v: unknown, max: number): string | null | undefined =>
  v === undefined || v === null || v === "" ? "" : typeof v === "string" && v.length <= max ? v.trim() : null;

export type ParsedPost = { ok: true; input: SocialPostInput } | { ok: false; error: string };

export function parsePostInput(body: Record<string, unknown> | null): ParsedPost {
  if (!body) return { ok: false, error: "Invalid request." };
  const title = str(body.title, LIMITS.title);
  if (!title) return { ok: false, error: `Give the post a title (1 to ${LIMITS.title} characters).` };
  if (!isPlatform(body.platform)) return { ok: false, error: "Choose Instagram, Facebook or LinkedIn." };
  const topic = optional(body.topic, LIMITS.topic);
  const caption = optional(body.caption, LIMITS.caption);
  const creativeBrief = optional(body.creativeBrief, LIMITS.brief);
  const imageDirection = optional(body.imageDirection, LIMITS.image);
  if (topic === null) return { ok: false, error: `Topic is too long (max ${LIMITS.topic}).` };
  if (caption === null) return { ok: false, error: `Caption is too long (max ${LIMITS.caption}).` };
  if (creativeBrief === null) return { ok: false, error: `Creative brief is too long (max ${LIMITS.brief}).` };
  if (imageDirection === null) return { ok: false, error: `Image direction is too long (max ${LIMITS.image}).` };
  const scheduledFor = body.scheduledFor === undefined || body.scheduledFor === "" ? undefined : body.scheduledFor;
  if (scheduledFor !== undefined && !isIsoDate(scheduledFor)) return { ok: false, error: "Choose a valid date." };
  return {
    ok: true,
    input: { title, topic: topic ?? "", platform: body.platform, caption: caption ?? "", hashtags: normalizeHashtags(body.hashtags),
      creativeBrief: creativeBrief ?? "", imageDirection: imageDirection ?? "", ...(scheduledFor ? { scheduledFor } : {}) },
  };
}

/** The text a reviewer sees in the approval queue (and that the claim guard scans). */
export function renderPostForApproval(p: Pick<SocialPost, "platform" | "caption" | "hashtags" | "creativeBrief" | "imageDirection">): string {
  return [
    `Platform: ${p.platform} (simulated, not posted)`,
    `Caption: ${p.caption || "[no caption yet]"}`,
    `Hashtags: ${p.hashtags.length ? p.hashtags.join(" ") : "[none]"}`,
    `Creative brief: ${p.creativeBrief || "[none]"}`,
    `Image direction: ${p.imageDirection || "[none]"}`,
  ].join("\n");
}

export function deriveStatus(post: SocialPost, approvalStatus?: ApprovalStatus): SocialStatus {
  if (post.simulatedPublished) return "simulated_published";
  if (post.approvalId && approvalStatus) {
    return approvalStatus === "pending" ? "pending_approval" : approvalStatus === "rejected" ? "rejected" : "approved";
  }
  return post.seedStatus ?? "draft";
}

const DAY = 86_400_000;
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);
const startOfUtcDay = (d: Date): Date => new Date(`${isoDate(d)}T00:00:00Z`);

/** Deterministic, clearly invented numbers for a post that a visitor "published" in the simulation. */
export function sampleMetricsFor(id: string): SocialMetrics {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const reach = 900 + (h % 3200);
  const likes = Math.round(reach * (0.05 + ((h >> 3) % 40) / 1000));
  const comments = 3 + ((h >> 5) % 20);
  const shares = 2 + ((h >> 7) % 25);
  const clicks = 20 + ((h >> 9) % 80);
  return { reach, likes, comments, shares, clicks, engagement: Math.round(((likes + comments + shares) / reach) * 1000) / 10 };
}

export function toView(post: SocialPost, today: Date, approvalStatus?: ApprovalStatus): SocialPostView {
  const status = deriveStatus(post, approvalStatus);
  const scheduledFor = post.scheduledFor ?? isoDate(addDays(startOfUtcDay(today), post.dayOffset ?? 0));
  const metrics = status === "simulated_published" ? post.metrics ?? sampleMetricsFor(post.id) : undefined;
  return { ...post, status, scheduledFor, metrics };
}

export interface CalendarDay { date: string; day: number; month: string; isToday: boolean; posts: SocialPostView[] }

/** A rolling calendar of `weeks` full weeks (Monday first), starting `back` weeks before the week that contains `today`,
 *  so recent (simulated published) posts stay visible. */
export function buildCalendar(posts: SocialPostView[], today: Date, weeks = 5, back = 1): CalendarDay[][] {
  const t = startOfUtcDay(today);
  const monday = addDays(t, -((t.getUTCDay() + 6) % 7) - 7 * back);
  const byDate = new Map<string, SocialPostView[]>();
  for (const p of posts) byDate.set(p.scheduledFor, [...(byDate.get(p.scheduledFor) ?? []), p]);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(monday, w * 7 + d);
      const iso = isoDate(date);
      return { date: iso, day: date.getUTCDate(), month: date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }), isToday: iso === isoDate(t), posts: byDate.get(iso) ?? [] };
    }));
}

export const STATUS_LABEL: Record<SocialStatus, string> = {
  draft: "Draft", pending_approval: "Pending approval", approved: "Approved", rejected: "Rejected", simulated_published: "Simulated · not posted",
};

export function summarize(posts: SocialPostView[]) {
  const count = (s: SocialStatus) => posts.filter((p) => p.status === s).length;
  const published = posts.filter((p) => p.metrics);
  const reach = published.reduce((n, p) => n + (p.metrics?.reach ?? 0), 0);
  const interactions = published.reduce((n, p) => n + (p.metrics ? p.metrics.likes + p.metrics.comments + p.metrics.shares : 0), 0);
  return {
    total: posts.length, drafts: count("draft"), pending: count("pending_approval"), approved: count("approved"),
    rejected: count("rejected"), simulated: count("simulated_published"), reach,
    engagement: reach ? Math.round((interactions / reach) * 1000) / 10 : 0,
    clicks: published.reduce((n, p) => n + (p.metrics?.clicks ?? 0), 0),
  };
}
