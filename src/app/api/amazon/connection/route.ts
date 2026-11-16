import { NextResponse } from "next/server";
import { deny } from "@/lib/auth/access";
import { amazonErrorResponse, demoRefusal } from "@/lib/amazon/http";
import { amazonVerify, getAmazonLive } from "@/services/amazon-live";

/** GET: connection state for the signed-in live organisation (any member). */
export async function GET() {
  const denied = (await deny("data:read")) ?? (await demoRefusal());
  if (denied) return denied;
  try {
    const v = await getAmazonLive();
    if (v.state !== "ready") return NextResponse.json({ data: v });
    return NextResponse.json({ data: { state: v.state, environment: v.environment, simulated: v.simulated, marketplaceId: v.marketplaceId, connection: v.connection } });
  } catch (e) { return amazonErrorResponse(e); }
}

/** POST: ask Amazon which marketplaces the seller participates in and record whether Amazon India is verified. Owner/admin only. */
export async function POST(req: Request) {
  const denied = (await deny("amazon:sync", req)) ?? (await demoRefusal());
  if (denied) return denied;
  try { return NextResponse.json({ data: await amazonVerify() }); } catch (e) { return amazonErrorResponse(e); }
}
