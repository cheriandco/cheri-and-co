import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { parseFollowUpInput, parseReplyInput } from "@/lib/b2c-live/validate";
import { readJson } from "@/lib/validate";
import { createFollowUp, draftReply, recommendForEnquiry, setEnquiryClosed } from "@/services/b2c-live";
import { handle, respond } from "../../../_http";

/** The AI call can take a while; the client times out earlier (AI_TIMEOUT_MS, default 30 s). */
export const maxDuration = 60;

/** POST /api/b2c/enquiries/:id/(recommendations|reply|follow-up|close|reopen).
 *   recommendations: deterministic catalogue matches (nothing saved). reply: drafts or regenerates the reply (saved as a draft; AI only when enabled).
 *   follow-up: { dueDate, reason, assigneeId?, priority? } creates one open follow-up task. Nothing here sends anything to a customer. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const denied = await deny("enquiries:write", req);
  if (denied) return denied;
  const { id, action } = await ctx.params;
  const body = await readJson(req);
  if (action === "recommendations") {
    const p = parseReplyInput(body);
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    return handle(async () => respond(await recommendForEnquiry(id, p.value.productId), (r) => ({ data: r })));
  }
  if (action === "reply") {
    const p = parseReplyInput(body);
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    return handle(async () => respond(await draftReply(id, { productId: p.value.productId }), (r) => ({ data: r.message, generator: r.outcome.generator, note: r.outcome.note, recommendations: r.outcome.recommendations, context: r.outcome.context, regenerated: r.regenerated, catalogueNotes: r.catalogueNotes }), 200));
  }
  if (action === "follow-up") {
    const p = parseFollowUpInput(body);
    if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
    return handle(async () => respond(await createFollowUp(id, p.value), (r) => ({ data: r.followUp }), 201));
  }
  if (action === "close" || action === "reopen") return handle(async () => respond(await setEnquiryClosed(id, action === "close"), (r) => ({ data: r.enquiry })));
  return NextResponse.json({ error: "Unknown action." }, { status: 404 });
}
