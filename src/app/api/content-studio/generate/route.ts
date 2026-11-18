import { deny, errorResponse } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { isStudioKind } from "@/lib/content-studio/kinds";
import { cleanTheme } from "@/lib/content-studio/prompt";
import { AUDIENCES } from "@/types/content-agent";
import type { Audience } from "@/types/content-agent";
import { readJson } from "@/lib/validate";
import { generateStudioDraft } from "@/services/content-studio";

/** The AI call can take a while; the client times out earlier (AI_TIMEOUT_MS, default 30 s). */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = { not_live: 404, product_not_found: 404, product_archived: 409, post_not_found: 404, invalid_state: 409 } as const;

/** POST /api/content-studio/generate { productId, kind, audience, theme?, postId? }. Drafts copy from one catalogue product and saves it as a draft
 *  (postId = regenerate that draft). Uses AI only for a live organisation with AI_ENABLED=true; otherwise a template. Never publishes or sends. */
export async function POST(req: Request) {
  const denied = await deny("content:submit", req);
  if (denied) return denied;
  const b = await readJson(req);
  const theme = cleanTheme(b?.theme);
  const audience = b?.audience === undefined || b.audience === "" ? "everyday" : b.audience;
  if (!b || typeof b.productId !== "string" || !UUID.test(b.productId) || !isStudioKind(b.kind) || !AUDIENCES.includes(audience as Audience)
    || !theme.ok || (b.postId !== undefined && (typeof b.postId !== "string" || !UUID.test(b.postId)))) {
    return NextResponse.json({ error: "Choose a product and a content type. The campaign note must be plain text of up to 200 characters." }, { status: 400 });
  }
  try {
    const res = await generateStudioDraft({ productId: b.productId, kind: b.kind, audience: audience as Audience, theme: theme.theme, postId: b.postId as string | undefined });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: STATUS[res.reason] });
    return NextResponse.json({ data: res.post, generator: res.generator, note: res.note, regenerated: res.regenerated }, { status: res.regenerated ? 200 : 201 });
  } catch (e) { return errorResponse(e); }
}
