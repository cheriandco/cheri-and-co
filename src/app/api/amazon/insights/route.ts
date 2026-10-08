import { NextResponse } from "next/server";
import { getAmazon } from "@/services";

export async function GET() {
  return NextResponse.json(await getAmazon());
}
