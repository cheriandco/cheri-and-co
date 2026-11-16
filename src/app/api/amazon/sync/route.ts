import { NextResponse } from "next/server";
import { deny } from "@/lib/auth/access";
import { amazonErrorResponse, demoRefusal } from "@/lib/amazon/http";
import { readJson, str } from "@/lib/validate";
import { SYNC_KINDS } from "@/lib/amazon/sync/run";
import { amazonSyncStep } from "@/services/amazon-live";

/** POST {kind}: runs ONE bounded step of that sync. The browser repeats the call until the answer says "done" or "failed" (waiting answers carry retryAfterMs).
 *  Owner/admin only. It runs in the caller's own session: there is no background worker and no service-role key. */
export async function POST(req: Request) {
  const denied = (await deny("amazon:sync", req)) ?? (await demoRefusal());
  if (denied) return denied;
  const body = await readJson(req);
  const kind = str(body?.kind, 20);
  if (!kind || !(SYNC_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  try { return NextResponse.json({ data: await amazonSyncStep(kind) }); } catch (e) { return amazonErrorResponse(e); }
}
