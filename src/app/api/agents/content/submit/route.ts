import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { submitContentDraft } from "@/services";
import { parseRunInput } from "@/lib/content-agent";
import { readJson } from "@/lib/validate";

/** POST /api/agents/content/submit. Queues a regenerated draft as a "Pending review" approval. Publishes nothing. */
export async function POST(req: Request) {
  const denied = await deny("content:submit", req);
  if (denied) return denied;
  const parsed = parseRunInput(await readJson(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const res = await submitContentDraft(parsed.input);
  if (res.ok) return NextResponse.json({ approval: res.approval }, { status: 201 });
  const status = res.reason === "invalid" ? 404 : res.reason === "duplicate" ? 409 : 422;
  return NextResponse.json({ error: res.error, issues: res.draft?.issues }, { status });
}
