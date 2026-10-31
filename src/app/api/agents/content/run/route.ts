import { NextResponse } from "next/server";
import { getContentSamples } from "@/services";
import { parseRunInput, runContentAgent } from "@/lib/content-agent";
import { readJson } from "@/lib/validate";

/** POST /api/agents/content/run. Drafts content from a SAMPLE record; nothing is stored, sent or published. */
export async function POST(req: Request) {
  const parsed = parseRunInput(await readJson(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { products, packs } = await getContentSamples();
  const run = runContentAgent(parsed.input, products, packs);
  if (!run.ok) return NextResponse.json({ error: run.error }, { status: 404 });
  return NextResponse.json({ draft: run.draft, note: run.note });
}
