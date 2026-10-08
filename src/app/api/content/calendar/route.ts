import { NextResponse } from "next/server";
import { getContent } from "@/services";

export async function GET() {
  return NextResponse.json((await getContent()).filter((c) => c.status !== "published"));
}
