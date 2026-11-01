import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { runB2CAgent } from "@/lib/b2c-agent";
import { MAX_ENQUIRY_LENGTH } from "@/lib/b2c-agent/client";
import { readJson, str } from "@/lib/validate";

/** POST /api/agents/b2c/run. Drafts a reply from the sample catalogue; nothing is sent or stored. */
export async function POST(req: Request) {
  const denied = await deny("agents:run", req);
  if (denied) return denied;
  const body = await readJson(req);
  const enquiry = str(body?.enquiry, MAX_ENQUIRY_LENGTH);
  if (!enquiry) return NextResponse.json({ error: `Enter an enquiry of 1 to ${MAX_ENQUIRY_LENGTH} characters.` }, { status: 400 });
  return NextResponse.json(runB2CAgent({ enquiry }));
}
