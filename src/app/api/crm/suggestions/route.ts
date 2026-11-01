import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { createTaskFromSuggestion, getSuggestions } from "@/services";
import { readJson, str } from "@/lib/validate";

/** GET /api/crm/suggestions. Rule-based next actions across the sample data. */
export async function GET() {
  const denied = await deny("data:read");
  if (denied) return denied;
  return NextResponse.json({ data: await getSuggestions() });
}

/** POST /api/crm/suggestions {key}. Creates a follow-up task from a suggestion, in this visitor's private copy. */
export async function POST(req: Request) {
  const denied = await deny("tasks:write", req);
  if (denied) return denied;
  const key = str((await readJson(req))?.key, 80);
  if (!key) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const task = await createTaskFromSuggestion(key);
  return task ? NextResponse.json({ data: task }, { status: 201 }) : NextResponse.json({ error: "Suggestion not found or already a task." }, { status: 404 });
}
