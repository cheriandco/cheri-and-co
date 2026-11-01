import { deny } from "@/lib/auth/access";
import { NextResponse } from "next/server";
import { getAmazon } from "@/services";

export async function GET() {
  const denied = await deny("data:read");
  if (denied) return denied;
  return NextResponse.json(await getAmazon());
}
