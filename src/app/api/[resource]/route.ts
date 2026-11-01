import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import * as s from "@/services";
import { isPriority, readJson, str } from "@/lib/validate";

/** Read-only collection endpoints share one handler; unknown resources 404. */
const readers: Record<string, () => Promise<unknown>> = {
  leads: s.getRetailers,
  customers: s.getCustomers,
  retailers: s.getRetailers,
  conversations: s.getConversations,
  products: s.getProducts,
  content: s.getContent,
  tasks: s.getTasks,
  approvals: s.getApprovals,
  reports: s.getReports,
};

export async function GET(_req: Request, ctx: { params: Promise<{ resource: string }> }) {
  const denied = await deny("data:read", _req);
  if (denied) return denied;
  const { resource } = await ctx.params;
  const read = readers[resource];
  if (!read) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await read());
}

export async function POST(req: Request, ctx: { params: Promise<{ resource: string }> }) {
  const denied = await deny("tasks:write", req);
  if (denied) return denied;
  const { resource } = await ctx.params;
  if (resource !== "tasks") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(req);
  const title = str(body?.title, 200);
  const due = str(body?.due, 60) ?? "Unscheduled";
  const assignee = str(body?.assignee, 60) ?? "Anika";
  const priority = body?.priority ?? "medium";
  if (!title || !isPriority(priority)) return NextResponse.json({ error: "Invalid task" }, { status: 400 });
  return NextResponse.json(await s.createTask({ title, due, assignee, priority }), { status: 201 });
}
