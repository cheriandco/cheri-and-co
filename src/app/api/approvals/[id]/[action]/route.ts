import { NextResponse } from "next/server";
import { decideApproval } from "@/services";
import { readJson, str } from "@/lib/validate";
import { MAX_PREVIEW_LENGTH } from "@/lib/content-agent/render";

type Ctx = { params: Promise<{ id: string; action: string }> };

/** POST /api/approvals/:id/(approve|reject|edit). Only pending approvals can be decided. Each successful call writes an audit entry. */
export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (action !== "approve" && action !== "reject" && action !== "edit")
    return NextResponse.json({ error: "Unknown action" }, { status: 404 });
  const body = await readJson(req);
  const note = str(body?.note, 500) ?? undefined;
  const edits = action === "edit" ? { title: str(body?.title, 200) ?? undefined, preview: str(body?.preview, MAX_PREVIEW_LENGTH) ?? undefined } : undefined;
  if (action === "edit" && !edits?.title && !edits?.preview) return NextResponse.json({ error: "Nothing to edit" }, { status: 400 });
  // TODO(auth): derive actor from the session once authentication lands.
  const res = await decideApproval(id, action, "Anika", note, edits);
  if (res.ok) return NextResponse.json(res.approval);
  if (res.reason === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (res.reason === "not_pending") return NextResponse.json({ error: "This item has already been decided." }, { status: 409 });
  return NextResponse.json({ error: "The draft contains wording that is not allowed. Edit it before approving.", issues: res.detail }, { status: 422 });
}
