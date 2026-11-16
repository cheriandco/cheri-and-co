import { NextResponse } from "next/server";
import { AuthError, ConflictError, errorResponse, isLiveOrg } from "@/lib/auth/access";
import { AmazonConfigError } from "./view";
import { AmazonStoreError } from "./supabase-repo";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Maps expected Amazon-integration failures to HTTP answers. Messages are fixed or already redacted; anything unexpected is rethrown, not hidden. */
export function amazonErrorResponse(e: unknown): NextResponse {
  if (e instanceof AmazonConfigError) return NextResponse.json({ error: e.message }, { status: 503, headers: NO_STORE });
  if (e instanceof AmazonStoreError) {
    const notInstalled = /not installed/.test(e.message);
    return NextResponse.json({ error: notInstalled ? "The Amazon tables are not installed in this database yet." : "Amazon data could not be read or saved." }, { status: notInstalled ? 503 : 500, headers: NO_STORE });
  }
  if (e instanceof AuthError || e instanceof ConflictError) return errorResponse(e);
  throw e;
}

/** Amazon Intelligence exists only for live organisations. The public demo and demo organisations keep their sample data. */
export async function demoRefusal(): Promise<NextResponse | null> {
  return (await isLiveOrg()) ? null : NextResponse.json({ error: "Amazon Intelligence is available for live organisations only." }, { status: 404, headers: NO_STORE });
}
