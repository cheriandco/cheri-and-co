import { NextResponse } from "next/server";
import { deny } from "@/lib/auth/access";
import { amazonErrorResponse, demoRefusal } from "@/lib/amazon/http";
import { amazonGenerateInsights } from "@/services/amazon-live";

/** POST: runs the deterministic rules over the synchronised data and stores the insights. No AI, no call to Amazon. */
export async function POST(req: Request) {
  const denied = (await deny("amazon:sync", req)) ?? (await demoRefusal());
  if (denied) return denied;
  try { return NextResponse.json({ data: await amazonGenerateInsights() }); } catch (e) { return amazonErrorResponse(e); }
}
