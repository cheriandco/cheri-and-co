import { NextResponse } from "next/server";
import { getActivities, getAgents } from "@/services";

/** GET /api/agents/status and /api/agents/activity */
export async function GET(_req: Request, ctx: { params: Promise<{ view: string }> }) {
  const { view } = await ctx.params;
  if (view === "status") return NextResponse.json(await getAgents());
  if (view === "activity") return NextResponse.json(await getActivities());
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
