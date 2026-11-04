/** CSV import service (M2). Live organisations only: the demo's sample data is read-only for these records, exactly as
 *  the forms are. Preview and import both re-read the organisation's current records and re-check the file on the server,
 *  so a stale preview can never import something the server would now refuse. Rows are saved one at a time through the same
 *  service functions as the forms (so the same validation, organisation scoping and database policies apply). */
import { AuthError, ConflictError, isLiveOrg } from "@/lib/auth/access";
import { analyseImport, EMPTY_CONTEXT, type Analysis, type ImportContext, type ImportReport, type ImportResource } from "@/lib/import";
import { createCustomer, createOrder, createRetailer, createTask, getCustomers, getOrders, getRetailers, getTasks, logImport } from "./index";

async function loadContext(resource: ImportResource): Promise<ImportContext> {
  const ctx: ImportContext = { ...EMPTY_CONTEXT };
  if (resource === "customers" || resource === "orders") ctx.customers = (await getCustomers()).map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, instagram: c.instagram, city: c.city }));
  if (resource === "retailers" || resource === "orders") ctx.retailers = (await getRetailers()).map((r) => ({ id: r.id, business: r.business, location: r.location, email: r.email, phone: r.phone }));
  if (resource === "tasks") ctx.tasks = (await getTasks()).filter((t) => t.status !== "done").map((t) => ({ title: t.title }));
  if (resource === "orders") ctx.orders = (await getOrders()).map((o) => ({ customerId: o.customerId, retailerId: o.retailerId, channel: o.channel, total: o.total, orderedAt: o.orderedAt }));
  return ctx;
}

async function analyse(resource: ImportResource, csv: string): Promise<Analysis | null> {
  if (!(await isLiveOrg())) return null;
  return analyseImport(resource, csv, await loadContext(resource));
}

/** Checks a file without saving anything. null in demo mode. */
export async function previewImport(resource: ImportResource, csv: string): Promise<{ report: ImportReport } | null> {
  const a = await analyse(resource, csv);
  return a ? { report: a.report } : null;
}

export interface ImportOutcome { report: ImportReport; created: number; failed: { line: number; label: string; error: string }[] }

const reason = (e: unknown) => (e instanceof ConflictError || e instanceof AuthError ? e.message : "Could not save this row.");

/** Saves every valid, non-duplicate row. A row that fails is reported and does not stop the others. null in demo mode. */
export async function runImport(resource: ImportResource, csv: string): Promise<ImportOutcome | null> {
  const a = await analyse(resource, csv);
  if (!a) return null;
  const failed: ImportOutcome["failed"] = [];
  let created = 0;
  for (const row of a.valid) {
    try {
      const p = row.parsed;
      const quiet = { quiet: true };
      const saved = p.resource === "customers" ? await createCustomer(p.input, quiet)
        : p.resource === "retailers" ? await createRetailer(p.input, quiet)
        : p.resource === "tasks" ? await createTask({ ...p.input, assignee: "Unassigned" }, undefined, quiet)
        : await createOrder(p.input, quiet);
      if (saved) created++; else failed.push({ line: row.line, label: row.label, error: "Not saved." });
    } catch (e) {
      failed.push({ line: row.line, label: row.label, error: reason(e) });
    }
  }
  await logImport(resource, created);
  return { report: a.report, created, failed };
}
