import { deny, isLiveOrg } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { getAmazon } from "@/services";
import { amazonErrorResponse } from "@/lib/amazon/http";
import { getAmazonLive } from "@/services/amazon-live";

export async function GET() {
  const denied = await deny("data:read");
  if (denied) return denied;
  if (await isLiveOrg()) {
    try {
      const v = await getAmazonLive();
      return NextResponse.json(v.state === "ready" ? { environment: v.environment, simulated: v.simulated, insights: v.insights } : { state: v.state, message: v.message, insights: [] });
    } catch (e) { return amazonErrorResponse(e); }
  }
  return NextResponse.json(await getAmazon());
}
