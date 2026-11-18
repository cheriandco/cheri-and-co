/** Content Studio server entry point: one product + one kind -> a saved draft in content_items (live organisations only).
 *  Reads the product through the signed-in user's own session (row level security + org filter), runs the generator (AI only when every gate in
 *  aiRuntime() passes; otherwise a template), then saves through the existing content functions so the activity history is written the same way.
 *  The draft is only a draft: sending it for approval is a separate, human step (POST /api/social/posts/:id/submit). Nothing is published. */
import { isLiveOrg } from "@/lib/auth/access";
import { readAiConfig } from "@/lib/ai/config";
import { runStudio, type StudioProduct } from "@/lib/content-studio/generate";
import { KIND_META, type StudioKind } from "@/lib/content-studio/kinds";
import { STUDIO_PROMPT_VERSION } from "@/lib/content-studio/prompt";
import { addDays, isoDate } from "@/lib/social/posts";
import type { Audience } from "@/types/content-agent";
import type { SocialPostView } from "@/types/social";
import { aiRuntime } from "./content-ai";
import { liveCreateSocialPost, liveProduct, liveSocialPost, liveUpdateSocialPost } from "./live";

export interface StudioRequestInput { productId: string; kind: StudioKind; audience: Audience; theme: string; postId?: string }

export type StudioResult =
  | { ok: true; post: SocialPostView; generator: "openai" | "template"; note: string; regenerated: boolean }
  | { ok: false; reason: "not_live" | "product_not_found" | "product_archived" | "post_not_found" | "invalid_state"; error: string };

export async function generateStudioDraft(input: StudioRequestInput): Promise<StudioResult> {
  if (!(await isLiveOrg())) return { ok: false, reason: "not_live", error: "The Content Studio is available to signed-in live organisations only." };
  const p = await liveProduct(input.productId);
  if (!p) return { ok: false, reason: "product_not_found", error: "Product not found." };
  if (p.status === "archived") return { ok: false, reason: "product_archived", error: "Archived products cannot be drafted." };

  // A regenerate must target an editable draft of this organisation BEFORE any AI call is spent.
  if (input.postId) {
    const existing = await liveSocialPost(input.postId);
    if (!existing) return { ok: false, reason: "post_not_found", error: "Draft not found." };
    if (existing.status !== "draft" && existing.status !== "rejected") return { ok: false, reason: "invalid_state", error: "Only drafts and rejected posts can be regenerated." };
  }

  const product: StudioProduct = { id: p.id, name: p.name, category: p.category, description: p.description ?? null, imageUrl: p.imageUrl ?? null };
  // AI off (the default): the AI runtime is never even consulted, so no transport, key or usage ledger is touched. It is resolved only when AI_ENABLED is on.
  const runtime = readAiConfig().enabled ? await aiRuntime() : null;
  const outcome = await runStudio({ product, kind: input.kind, audience: input.audience, theme: input.theme }, runtime);
  const label = KIND_META[input.kind].label;
  const how = outcome.generator === "openai" ? `AI draft (${outcome.model}, ${outcome.promptVersion ?? STUDIO_PROMPT_VERSION})` : "Template draft";

  if (input.postId) {
    const res = await liveUpdateSocialPost(input.postId, outcome.post, `Regenerated ${label} for ${p.name}: ${how}`);
    if (!res.ok) return { ok: false, reason: res.reason === "not_found" ? "post_not_found" : "invalid_state", error: res.error };
    return { ok: true, post: res.post, generator: outcome.generator, note: outcome.note, regenerated: true };
  }
  const created = await liveCreateSocialPost(outcome.post, isoDate(addDays(new Date(), 7)), `Generated ${label} for ${p.name}: ${how}`);
  const view = await liveSocialPost(created.id);
  return { ok: true, post: view ?? { ...created, status: "draft", scheduledFor: created.scheduledFor ?? isoDate(new Date()) }, generator: outcome.generator, note: outcome.note, regenerated: false };
}
