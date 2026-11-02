import { deny, errorResponse } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import * as s from "@/services";
import { isPriority, parseCustomerInput, parseOrderInput, parseProductInput, parseRetailerInput, readJson, str } from "@/lib/validate";

/** Read-only collection endpoints share one handler; unknown resources 404. */
const readers: Record<string, () => Promise<unknown>> = {
  leads: s.getRetailers,
  customers: s.getCustomers,
  retailers: s.getRetailers,
  conversations: s.getConversations,
  products: s.getProducts,
  orders: s.getOrders,
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
  const { resource } = await ctx.params;
  const denied = await deny(resource === "tasks" ? "tasks:write" : resource === "products" ? "products:write" : resource === "orders" ? "orders:write" : "pipeline:write", req);
  if (denied) return denied;
  if (resource === "customers" || resource === "retailers" || resource === "products" || resource === "orders") {
    try { return await createRecord(resource, await readJson(req)); } catch (e) { return errorResponse(e); }
  }
  if (resource !== "tasks") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(req);
  const title = str(body?.title, 200);
  const due = str(body?.due, 60) ?? "Unscheduled";
  const assignee = str(body?.assignee, 60) ?? "Anika"; // the sample demo's founder; a live organisation does not store assignees yet, so this is ignored there
  const priority = body?.priority ?? "medium";
  if (!title || !isPriority(priority)) return NextResponse.json({ error: "Invalid task" }, { status: 400 });
  try { return NextResponse.json(await s.createTask({ title, due, assignee, priority }), { status: 201 }); } catch (e) { return errorResponse(e); }
}

/** Customers, retailers, products and orders can be created only in a live organisation (the sample demo is read-only here, so it 404s as before).
 *  The organisation is taken from the session by the service, never from this body. */
async function createRecord(resource: "customers" | "retailers" | "products" | "orders", body: Record<string, unknown> | null) {
  if (resource === "orders") {
    const input = parseOrderInput(body);
    if (!input) return NextResponse.json({ error: "Invalid order" }, { status: 400 });
    const created = await s.createOrder(input);
    return created ? NextResponse.json(created, { status: 201 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (resource === "products") {
    const input = parseProductInput(body);
    if (!input) return NextResponse.json({ error: "Invalid product" }, { status: 400 });
    const created = await s.createProduct(input);
    return created ? NextResponse.json(created, { status: 201 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (resource === "customers") {
    const input = parseCustomerInput(body);
    if (!input) return NextResponse.json({ error: "Invalid customer" }, { status: 400 });
    const created = await s.createCustomer(input);
    return created ? NextResponse.json(created, { status: 201 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const input = parseRetailerInput(body);
  if (!input) return NextResponse.json({ error: "Invalid retailer" }, { status: 400 });
  const created = await s.createRetailer(input);
  return created ? NextResponse.json(created, { status: 201 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
