import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { getOrchestratorBrief } from "@/services";

/** GET /api/orchestrator/brief. Cross-agent summary of the sample data. Read-only: it recommends and never acts. */
export async function GET() {
  const denied = await deny("data:read");
  if (denied) return denied;
  return NextResponse.json({ data: await getOrchestratorBrief() });
}
