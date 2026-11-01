import { deny, errorResponse } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { createSocialPost, getSocialPosts } from "@/services";
import { parsePostInput } from "@/lib/social/posts";
import { readJson } from "@/lib/validate";

/** GET /api/social/posts. Sample plus this visitor's own simulated posts. */
export async function GET() {
  const denied = await deny("data:read");
  if (denied) return denied;
  return NextResponse.json({ data: await getSocialPosts() });
}

/** POST /api/social/posts. Creates a draft (a visitor's private demo copy, or the live organisation's content calendar). Publishes nothing. */
export async function POST(req: Request) {
  const denied = await deny("content:submit", req);
  if (denied) return denied;
  const parsed = parsePostInput(await readJson(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json({ data: await createSocialPost(parsed.input) }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
