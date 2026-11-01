import { deny, errorResponse } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { simulatePublishSocialPost, submitSocialPost, updateSocialPost, type SocialResult } from "@/services";
import { parsePostInput } from "@/lib/social/posts";
import { readJson } from "@/lib/validate";

const STATUS = { not_found: 404, invalid_state: 409, prohibited_claims: 422 } as const;

function respond(res: SocialResult) {
  if (res.ok) return NextResponse.json({ data: res.post });
  return NextResponse.json({ error: res.error, issues: res.detail }, { status: STATUS[res.reason] });
}

/** POST /api/social/posts/:id/(edit|submit|publish). All simulated: nothing is posted to any platform. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const denied = await deny("content:submit", req);
  if (denied) return denied;
  const { id, action } = await ctx.params;
  try {
    if (action === "submit") return respond(await submitSocialPost(id));
    if (action === "publish") return respond(await simulatePublishSocialPost(id));
    if (action === "edit") {
      const parsed = parsePostInput(await readJson(req));
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      return respond(await updateSocialPost(id, parsed.input));
    }
  } catch (e) { return errorResponse(e); }
  return NextResponse.json({ error: "Unknown action." }, { status: 404 });
}
