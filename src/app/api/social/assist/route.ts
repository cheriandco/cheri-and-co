import { NextResponse } from "next/server";
import { parseAssistInput, runAssist } from "@/lib/social/assist";
import { readJson } from "@/lib/validate";

/** POST /api/social/assist. Template-based demo suggestions. No AI model, network call or key is involved. */
export async function POST(req: Request) {
  const parsed = parseAssistInput(await readJson(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json({ data: runAssist(parsed) });
}
