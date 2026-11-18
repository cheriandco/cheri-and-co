import { deny, isLiveOrg } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { parseEnquiryInput, parseListQuery } from "@/lib/b2c-live/validate";
import { ENQUIRY_STATUSES } from "@/types/enquiry";
import { readJson } from "@/lib/validate";
import { createEnquiry, listEnquiries } from "@/services/b2c-live";
import { handle, respond } from "../_http";

/** GET /api/b2c/enquiries?limit=50&offset=0&status=&customerId=. The signed-in live organisation's enquiries, newest activity first, a page at a time. */
export async function GET(req?: Request) {
  const denied = await deny("data:read");
  if (denied) return denied;
  const q = parseListQuery(req ? new URL(req.url).searchParams : new URLSearchParams(), ENQUIRY_STATUSES);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
  return handle(async () => {
    if (!(await isLiveOrg())) return NextResponse.json({ error: "Enquiries are available to signed-in live organisations only." }, { status: 404 });
    const { items, page } = await listEnquiries(q.value);
    return NextResponse.json({ data: items, page }, { headers: { "Cache-Control": "no-store" } });
  });
}

/** POST /api/b2c/enquiries { source, message, productId?, customerId? | customer?: { name, email?, phone?, instagram?, city? } }.
 *  Logs a customer enquiry. `customer` finds an existing customer by email, phone or Instagram, or creates one. The same message from the same customer on the
 *  same channel within 10 minutes is refused with 409 and the id of the existing enquiry. Nothing is sent and no AI is called. */
export async function POST(req: Request) {
  const denied = await deny("enquiries:write", req);
  if (denied) return denied;
  const parsed = parseEnquiryInput(await readJson(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return handle(async () => respond(await createEnquiry(parsed.value), (r) => ({ data: r.enquiry, customer: r.customer, ...(r.warning ? { warning: r.warning } : {}) }), 201));
}
