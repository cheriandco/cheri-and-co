import { NextResponse } from "next/server";
import { queueAgentAction, type QueueAgent } from "@/services";
import { readJson, str } from "@/lib/validate";

const AGENTS: QueueAgent[] = ["b2c", "b2b", "amazon"];

/** POST /api/agent-actions {agent, ref}. Queues the agent's suggestion in Approvals. Sends, posts and changes nothing. */
export async function POST(req: Request) {
  const body = await readJson(req);
  const agent = body?.agent;
  const ref = str(body?.ref, 80);
  if (!ref || typeof agent !== "string" || !(AGENTS as string[]).includes(agent)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const res = await queueAgentAction(agent as QueueAgent, ref);
  if (res.ok) return NextResponse.json({ data: res.approval }, { status: 201 });
  return NextResponse.json({ error: res.error }, { status: res.reason === "not_found" ? 404 : 409 });
}
