import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { getContentSamples } from "@/services";
import { runContentDraft } from "@/services/content-ai";
import { parseRunInput } from "@/lib/content-agent";
import { readJson } from "@/lib/validate";

/** The AI call can take a while; the client times out earlier (AI_TIMEOUT_MS, default 30 s). */
export const maxDuration = 60;

/** POST /api/agents/content/run. Drafts content; nothing is stored, sent or published. In the public demo this is the template
 *  generator over SAMPLE records. For a signed-in live organisation it may use AI (only when AI_ENABLED=true), with a template fallback. */
export async function POST(req: Request) {
  const denied = await deny("agents:run", req);
  if (denied) return denied;
  const parsed = parseRunInput(await readJson(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { products, packs } = await getContentSamples();
  const run = await runContentDraft(parsed.input, products, packs);
  if (!run.ok) return NextResponse.json({ error: run.error }, { status: 404 });
  return NextResponse.json({ draft: run.draft, note: run.note });
}
