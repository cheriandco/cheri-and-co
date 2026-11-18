import { AuthError, ConflictError, errorResponse } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { NotSetUpError, type B2cFailure, type B2cResult } from "@/services/b2c-live";

const STATUS: Record<B2cFailure, number> = {
  not_live: 404, not_found: 404, customer_not_found: 404, product_not_found: 404, invalid_state: 409, duplicate: 409, assignee_not_member: 422, prohibited_claims: 422,
};
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Runs a handler and turns every outcome into JSON: refusals by reason, a missing migration into 503, and real faults into a logged 500. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotSetUpError) return NextResponse.json({ error: e.message }, { status: 503, headers: NO_STORE });
    if (e instanceof AuthError || e instanceof ConflictError) return errorResponse(e);
    console.error("[b2c]", e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
    return NextResponse.json({ error: "The request could not be completed because of a server error. The server log has the details." }, { status: 500, headers: NO_STORE });
  }
}

/** Success -> the body `pick` builds, with `status`; refusal -> { error, issues? } with the status for its reason. */
export function respond<T extends object>(res: B2cResult<T>, pick: (r: T) => Record<string, unknown>, status = 200): NextResponse {
  if (res.ok) return NextResponse.json(pick(res), { status, headers: NO_STORE });
  return NextResponse.json({ error: res.error, ...(res.detail ? { issues: res.detail } : {}), ...(res.existingId ? { existingId: res.existingId } : {}) }, { status: STATUS[res.reason], headers: NO_STORE });
}
