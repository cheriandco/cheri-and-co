import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { getDashboardSummary } from "@/services";

export async function GET(req: Request) {
  const denied = await deny("data:read", req);
  if (denied) return denied;
  const range = new URL(req.url).searchParams.get("range") ?? "7d";
  return NextResponse.json(await getDashboardSummary(range));
}
