import { deny, errorResponse } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import * as s from "@/services";
import { isOrderStatus, isStage, parseProductInput, readJson, str } from "@/lib/validate";

type Ctx = { params: Promise<{ resource: string; id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const denied = await deny("data:read", _req);
  if (denied) return denied;
  const { resource, id } = await ctx.params;
  const row =
    resource === "customers" ? await s.getCustomer(id)
    : resource === "retailers" || resource === "leads" ? await s.getRetailer(id)
    : resource === "products" ? await s.getProduct(id)
    : resource === "orders" ? await s.getOrder(id)
    : undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { resource, id } = await ctx.params;
  const denied = await deny(resource === "products" ? "products:write" : resource === "orders" ? "orders:write" : "pipeline:write", req);
  if (denied) return denied;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  if (resource === "orders") {
    if (!isOrderStatus(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    try {
      const order = await s.updateOrderStatus(id, body.status);
      return order ? NextResponse.json(order) : NextResponse.json({ error: "Not found" }, { status: 404 });
    } catch (e) { return errorResponse(e); }
  }
  if (resource === "products") {
    const input = parseProductInput(body);
    if (!input) return NextResponse.json({ error: "Invalid product" }, { status: 400 });
    try {
      const product = await s.updateProduct(id, input);
      return product ? NextResponse.json(product) : NextResponse.json({ error: "Not found" }, { status: 404 });
    } catch (e) { return errorResponse(e); }
  }
  if (resource === "tasks") {
    const status = body.status;
    if (status !== undefined && status !== "open" && status !== "done" && status !== "postponed")
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    try {
      const task = await s.updateTask(id, { status, due: str(body.due, 60) ?? undefined, assignee: str(body.assignee, 60) ?? undefined });
      return task ? NextResponse.json(task) : NextResponse.json({ error: "Not found" }, { status: 404 });
    } catch (e) { return errorResponse(e); }
  }
  if (resource === "pipeline" || resource === "leads") {
    if (!isStage(body.stage)) return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    try {
      const deal = await s.moveDeal(id, body.stage);
      return deal ? NextResponse.json(deal) : NextResponse.json({ error: "Not found" }, { status: 404 });
    } catch (e) { return errorResponse(e); }
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
