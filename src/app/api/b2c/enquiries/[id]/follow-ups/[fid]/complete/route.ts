import { deny } from "@/lib/auth/access";
import { updateFollowUp } from "@/services/b2c-live";
import { handle, respond } from "../../../../../_http";

/** POST /api/b2c/enquiries/:id/follow-ups/:fid/complete. Marks the follow-up done. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; fid: string }> }) {
  const denied = await deny("enquiries:write", req);
  if (denied) return denied;
  const { id, fid } = await ctx.params;
  return handle(async () => respond(await updateFollowUp(id, fid, { status: "done" }), (r) => ({ data: r.followUp })));
}
