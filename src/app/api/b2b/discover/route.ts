import { NextResponse } from "next/server";
import { addDiscoveredRetailer, getDiscovery } from "@/services";
import { readJson, str } from "@/lib/validate";

/** GET /api/b2b/discover. A fixed list of SAMPLE candidates with rule-based fit scores. No search is run anywhere. */
export async function GET() {
  return NextResponse.json({ data: await getDiscovery() });
}

/** POST /api/b2b/discover {id}. Adds a SAMPLE candidate to this visitor's private leads. */
export async function POST(req: Request) {
  const id = str((await readJson(req))?.id, 40);
  if (!id) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const res = await addDiscoveredRetailer(id);
  if (res.ok) return NextResponse.json({ data: res.retailer }, { status: 201 });
  return NextResponse.json({ error: res.error }, { status: res.reason === "not_found" ? 404 : 409 });
}
