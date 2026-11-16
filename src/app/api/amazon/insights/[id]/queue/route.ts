import { NextResponse } from "next/server";
import { deny } from "@/lib/auth/access";
import { amazonErrorResponse, demoRefusal } from "@/lib/amazon/http";
import { amazonQueueInsight } from "@/services/amazon-live";

/** POST: sends one insight to the existing Approvals queue. Approving it later records a decision only; nothing is changed on Amazon. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = (await deny("agents:run", req)) ?? (await demoRefusal());
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const res = await amazonQueueInsight(id);
    if (res.ok) return NextResponse.json({ data: res.approval }, { status: 201 });
    return NextResponse.json({ error: res.error }, { status: res.reason === "not_found" ? 404 : res.reason === "prohibited_claims" ? 422 : 409 });
  } catch (e) { return amazonErrorResponse(e); }
}
