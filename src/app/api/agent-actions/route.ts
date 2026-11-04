import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { queueAgentAction, type QueueAgent } from "@/services";
import { readJson, str } from "@/lib/validate";
import { errorResponse } from "@/lib/auth/access";

const AGENTS: QueueAgent[] = ["b2c", "b2b", "amazon"];

/** POST /api/agent-actions {agent, ref}. Queues the agent's suggestion in Approvals. Sends, posts and changes nothing. */
export async function POST(req: Request) {
  const denied = await deny("agents:run", req);
  if (denied) return denied;
  const body = await readJson(req);
  const agent = body?.agent;
  const ref = str(body?.ref, 80);
  if (!ref || typeof agent !== "string" || !(AGENTS as string[]).includes(agent)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  let res;
  try { res = await queueAgentAction(agent as QueueAgent, ref); } catch (e) { return errorResponse(e); }
  if (res.ok) return NextResponse.json({ data: res.approval }, { status: 201 });
  return NextResponse.json({ error: res.error }, { status: res.reason === "not_found" ? 404 : res.reason === "prohibited_claims" ? 422 : 409 });
}
