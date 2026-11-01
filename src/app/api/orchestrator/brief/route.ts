import { NextResponse } from "next/server";
import { getOrchestratorBrief } from "@/services";

/** GET /api/orchestrator/brief. Cross-agent summary of the sample data. Read-only: it recommends and never acts. */
export async function GET() {
  return NextResponse.json({ data: await getOrchestratorBrief() });
}
