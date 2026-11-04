import { NextResponse } from "next/server";
import { deny, errorResponse } from "@/lib/auth/access";
import { isImportResource, type ImportResource } from "@/lib/import";
import type { Permission } from "@/lib/auth/roles";
import { readJson } from "@/lib/validate";
import { previewImport, runImport } from "@/services/import";

/** Saving up to 200 rows one by one can take a while on a slow connection. */
export const maxDuration = 60;

/** The same permission as creating one record of that kind by hand. */
const PERMISSION: Record<ImportResource, Permission> = { customers: "pipeline:write", retailers: "pipeline:write", tasks: "tasks:write", orders: "orders:write" };

/** POST { csv: string, commit?: boolean }. Without `commit` it only checks the file (a preview). With `commit: true` it re-checks and saves
 *  the valid, non-duplicate rows. The organisation always comes from the signed-in session, never from the request. */
export async function POST(req: Request, ctx: { params: Promise<{ resource: string }> }) {
  const { resource } = await ctx.params;
  if (!isImportResource(resource)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const denied = await deny(PERMISSION[resource], req);
  if (denied) return denied;
  const body = await readJson(req);
  if (!body || typeof body.csv !== "string") return NextResponse.json({ error: "Send the file text as { csv }" }, { status: 400 });
  try {
    const result = body.commit === true ? await runImport(resource, body.csv) : await previewImport(resource, body.csv);
    return result ? NextResponse.json(result) : NextResponse.json({ error: "CSV import is available for a real organisation only" }, { status: 404 });
  } catch (e) { return errorResponse(e); }
}
