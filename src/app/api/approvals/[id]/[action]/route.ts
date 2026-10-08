import { NextResponse } from "next/server";
import { decideApproval } from "@/services";
import { readJson, str } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string; action: string }> };

/** POST /api/approvals/:id/(approve|reject|edit). Every call writes an audit entry. */
export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (action !== "approve" && action !== "reject" && action !== "edit")
    return NextResponse.json({ error: "Unknown action" }, { status: 404 });
  const body = await readJson(req);
  const note = str(body?.note, 500) ?? undefined;
  const edits = action === "edit" ? { title: str(body?.title, 200) ?? undefined, preview: str(body?.preview, 2000) ?? undefined } : undefined;
  if (action === "edit" && !edits?.title && !edits?.preview) return NextResponse.json({ error: "Nothing to edit" }, { status: 400 });
  // TODO(auth): derive actor from the session once authentication lands.
  const approval = await decideApproval(id, action, "Anika", note, edits);
  return approval ? NextResponse.json(approval) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
