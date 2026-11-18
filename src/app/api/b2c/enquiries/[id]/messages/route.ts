import { deny, isLiveOrg } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { parseListQuery } from "@/lib/b2c-live/validate";
import { listMessages } from "@/services/b2c-live";
import { handle } from "../../../_http";

/** GET /api/b2c/enquiries/:id/messages?limit=50&offset=0. The conversation, oldest first, a page at a time. 404 for another organisation's enquiry. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await deny("data:read");
  if (denied) return denied;
  const q = parseListQuery(new URL(req.url).searchParams);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
  const { id } = await ctx.params;
  return handle(async () => {
    if (!(await isLiveOrg())) return NextResponse.json({ error: "Enquiries are available to signed-in live organisations only." }, { status: 404 });
    const res = await listMessages(id, q.value);
    if (!res) return NextResponse.json({ error: "Enquiry not found." }, { status: 404 });
    return NextResponse.json({ data: res.items, page: res.page }, { headers: { "Cache-Control": "no-store" } });
  });
}
