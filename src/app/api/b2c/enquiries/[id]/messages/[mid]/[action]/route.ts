import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { readJson } from "@/lib/validate";
import { editDraft, markSentManually, submitDraft } from "@/services/b2c-live";
import { handle, respond } from "../../../../../_http";

/** POST /api/b2c/enquiries/:id/messages/:mid/(edit|submit|mark-sent).
 *   edit { body }: a person's edit of a draft. submit: sends the draft to the Approval Centre (the only route to "approved").
 *   mark-sent: records that a person sent an APPROVED reply outside this app. The app itself never delivers a message. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; mid: string; action: string }> }) {
  const denied = await deny("enquiries:write", req);
  if (denied) return denied;
  const { id, mid, action } = await ctx.params;
  if (action === "edit") {
    const b = await readJson(req);
    if (!b || typeof b.body !== "string") return NextResponse.json({ error: "Send the reply text as { body }." }, { status: 400 });
    return handle(async () => respond(await editDraft(id, mid, b.body), (r) => ({ data: r.message })));
  }
  if (action === "submit") return handle(async () => respond(await submitDraft(id, mid), (r) => ({ data: r.message, approval: r.approval, alreadySubmitted: r.alreadySubmitted })));
  if (action === "mark-sent") return handle(async () => respond(await markSentManually(id, mid), (r) => ({ data: r.message })));
  return NextResponse.json({ error: "Unknown action." }, { status: 404 });
}
