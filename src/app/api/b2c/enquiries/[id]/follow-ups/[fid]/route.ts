import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { parseFollowUpPatch } from "@/lib/b2c-live/validate";
import { readJson } from "@/lib/validate";
import { updateFollowUp } from "@/services/b2c-live";
import { handle, respond } from "../../../../_http";

/** PATCH /api/b2c/enquiries/:id/follow-ups/:fid { status?, dueDate?, priority?, reason? }. Updates a follow-up task that belongs to this enquiry. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; fid: string }> }) {
  const denied = await deny("enquiries:write", req);
  if (denied) return denied;
  const { id, fid } = await ctx.params;
  const p = parseFollowUpPatch(await readJson(req));
  if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
  return handle(async () => respond(await updateFollowUp(id, fid, p.value), (r) => ({ data: r.followUp })));
}
