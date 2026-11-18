import { deny, isLiveOrg } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { getEnquiry } from "@/services/b2c-live";
import { handle } from "../../_http";

/** GET /api/b2c/enquiries/:id. One enquiry with its conversation history, follow-ups and activity. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await deny("data:read");
  if (denied) return denied;
  const { id } = await ctx.params;
  return handle(async () => {
    if (!(await isLiveOrg())) return NextResponse.json({ error: "Enquiries are available to signed-in live organisations only." }, { status: 404 });
    const e = await getEnquiry(id);
    return e ? NextResponse.json({ data: e }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "Enquiry not found." }, { status: 404 });
  });
}
