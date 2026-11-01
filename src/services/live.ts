/** Live data, read and written through the signed-in user's own Supabase session, so Row Level Security applies to
 *  every call. The organisation always comes from the verified session (`orgId`), never from a request. Used only for
 *  organisations that are not flagged is_demo. This covers tasks, approvals, the audit log, agent activity, customers, retailers and leads. */
import { cache } from "react";
import { AuthError } from "@/lib/auth/access";
import { getAuthUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import type { CustomerInput, RetailerInput } from "@/lib/validate";
import type { Activity, AgentKey, Approval, AuditEntry, Customer, Deal, PipelineStage, Retailer, Task } from "@/types";
import {
  parseDue, toActivity, toApproval, toAudit, toCustomer, toDeal, toRetailer, toTask,
  type ActivityRow, type ApprovalRow, type AuditRow, type CustomerRow, type LeadRow, type RetailerRow, type TaskRow,
} from "./live-map";
import type { Store } from "./store";

export class LiveError extends Error {}

async function ctx() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();
  if (!user?.orgId || !supabase) throw new AuthError(401, "Authentication required");
  return { supabase, orgId: user.orgId, userId: user.id };
}

/** A database error becomes a 403 when Row Level Security or a missing privilege refused it, otherwise a plain error. */
function fail(error: { code?: string; message: string }): never {
  if (error.code === "42501" || /row-level security|permission denied|not authorized/i.test(error.message))
    throw new AuthError(403, "You do not have permission to do this");
  throw new LiveError("Database request failed");
}

async function names(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  const { data } = await supabase.from("profiles").select("id, display_name").in("id", unique);
  for (const p of (data ?? []) as { id: string; display_name: string | null }[]) if (p.display_name) out.set(p.id, p.display_name);
  return out;
}

export async function liveTasks(): Promise<Task[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("tasks").select("id, title, source, due_at, priority, status, assignee_id, related_ref")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(200);
  if (error) fail(error);
  const rows = (data ?? []) as TaskRow[];
  const n = await names(supabase, rows.map((r) => r.assignee_id));
  return rows.map((r) => toTask(r, n));
}

export async function liveCreateTask(input: Pick<Task, "title" | "due" | "priority">, from?: Pick<Task, "source" | "href">): Promise<Task> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("tasks").insert({
    org_id: orgId, title: input.title, priority: input.priority, due_at: parseDue(input.due),
    source: from?.source ?? "Manual", related_ref: from?.href ?? null,
  }).select("id, title, source, due_at, priority, status, assignee_id, related_ref").single();
  if (error) fail(error);
  await liveLog({ agent: "crm", action: `Created task: ${input.title}` });
  return toTask(data as TaskRow, new Map());
}

export async function liveUpdateTask(id: string, patch: Partial<Pick<Task, "status" | "due">>): Promise<Task | null> {
  const { supabase, orgId } = await ctx();
  const change: Record<string, unknown> = {};
  if (patch.status) change.status = patch.status;
  if (patch.due !== undefined) change.due_at = parseDue(patch.due);
  if (!Object.keys(change).length) return null;
  const { data, error } = await supabase.from("tasks").update(change).eq("org_id", orgId).eq("id", id)
    .select("id, title, source, due_at, priority, status, assignee_id, related_ref");
  if (error) fail(error);
  const row = ((data ?? []) as TaskRow[])[0];
  return row ? toTask(row, new Map()) : null;
}

export async function liveApprovals(): Promise<Approval[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("approvals").select("id, title, type, generated_by, status, preview, meta, created_at")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(200);
  if (error) fail(error);
  return ((data ?? []) as ApprovalRow[]).map((r) => toApproval(r));
}

export type LiveDecision =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "not_found" | "not_pending" | "prohibited_claims"; detail?: string[] };

/** The database function does the permission check, the state check and the audit row in one step, and records the
 *  real signed-in user as the actor. The claim guard still runs here before an approval. */
export async function liveDecideApproval(id: string, action: "approve" | "reject" | "edit", note?: string, edits?: { title?: string; preview?: string }): Promise<LiveDecision> {
  const { supabase, orgId } = await ctx();
  if (action === "approve") {
    const { data } = await supabase.from("approvals").select("preview, meta").eq("org_id", orgId).eq("id", id).maybeSingle();
    const row = data as { preview: string; meta: { kind?: string; allowedClaims?: string[] } | null } | null;
    if (row?.meta?.kind === "content_draft") {
      const violations = findProhibitedClaims(row.preview, row.meta.allowedClaims ?? []);
      if (violations.length) return { ok: false, reason: "prohibited_claims", detail: violations.map((v) => `${v.label}: "${v.match}"`) };
    }
  }
  const { data, error } = await supabase.rpc("decide_approval", { p_id: id, p_action: action, p_note: note ?? null, p_title: edits?.title ?? null, p_preview: edits?.preview ?? null });
  if (error) {
    if (/not found/i.test(error.message)) return { ok: false, reason: "not_found" };
    if (/already decided/i.test(error.message)) return { ok: false, reason: "not_pending" };
    fail(error);
  }
  const approval = toApproval(data as ApprovalRow);
  await liveLog({ agent: approval.generatedBy, action: `${action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Edited"}: ${approval.title}` });
  return { ok: true, approval };
}

export async function liveAudit(): Promise<AuditEntry[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("audit_log").select("id, approval_id, action, actor_id, note, at")
    .eq("org_id", orgId).order("at", { ascending: false }).limit(200);
  if (error) fail(error);
  const rows = ((data ?? []) as AuditRow[]).reverse(); // oldest first, like the sample store: the Approvals page reverses it
  const n = await names(supabase, rows.map((r) => r.actor_id));
  return rows.map((r) => toAudit(r, n));
}

export async function liveActivity(): Promise<Activity[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("agent_activity").select("id, agent, action, ref_id, actor_id, created_at")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(50);
  if (error) fail(error);
  const rows = (data ?? []) as ActivityRow[];
  const n = await names(supabase, rows.map((r) => r.actor_id));
  return rows.map((r) => toActivity(r, n));
}

/** Append-only history. A failure to log never undoes the action that was already saved. */
export async function liveLog(entry: { agent?: AgentKey; action: string }): Promise<void> {
  try {
    const { supabase, orgId, userId } = await ctx();
    await supabase.from("agent_activity").insert({ org_id: orgId, agent: entry.agent ?? null, action: entry.action.slice(0, 500), actor_id: userId });
  } catch { /* history is best effort */ }
}

/** The parts of the app's Store that live in the database. Everything else is empty on purpose: a live organisation
 *  never sees sample records. Memoised per request so one page render makes four queries at most. */
export const loadLiveStore = cache(async (): Promise<Store> => {
  const [tasks, approvals, audit, activity, pipeline] = await Promise.all([liveTasks(), liveApprovals(), liveAudit(), liveActivity(), liveRetailersAndDeals()]);
  return { tasks, approvals, audit, activity, deals: pipeline.deals, social: [], retailers: pipeline.retailers, links: {} };
});

/* ---------- Customers, retailers and leads ---------- */

const CUSTOMER_COLS = "id, name, instagram, phone, email, city, interests, created_at";
const RETAILER_COLS = "id, business, location, category, contact, email, phone, instagram, website, qualification, created_at";
const LEAD_COLS = "id, retailer_id, stage, score, temperature, owner_id, last_activity_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A customer's purchases are the number of their orders. */
async function purchaseCounts(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], orgId: string): Promise<Map<string, number>> {
  const { data } = await supabase.from("orders").select("customer_id").eq("org_id", orgId).not("customer_id", "is", null).limit(5000);
  const out = new Map<string, number>();
  for (const o of (data ?? []) as { customer_id: string }[]) out.set(o.customer_id, (out.get(o.customer_id) ?? 0) + 1);
  return out;
}

export async function liveCustomers(): Promise<Customer[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("customers").select(CUSTOMER_COLS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(500);
  if (error) fail(error);
  const counts = await purchaseCounts(supabase, orgId);
  return ((data ?? []) as CustomerRow[]).map((r) => toCustomer(r, counts.get(r.id) ?? 0));
}

export async function liveCustomer(id: string): Promise<Customer | null> {
  if (!UUID.test(id)) return null; // a malformed id would be a database error, not "not found"
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("customers").select(CUSTOMER_COLS).eq("org_id", orgId).eq("id", id).maybeSingle();
  if (error) fail(error);
  if (!data) return null;
  const counts = await purchaseCounts(supabase, orgId);
  return toCustomer(data as CustomerRow, counts.get(id) ?? 0);
}

export async function liveCreateCustomer(input: CustomerInput): Promise<Customer> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("customers").insert({ org_id: orgId, ...input }).select(CUSTOMER_COLS).single();
  if (error) fail(error);
  await liveLog({ agent: "crm", action: `Added customer: ${input.name}` });
  return toCustomer(data as CustomerRow, 0);
}

/** Retailers with their lead. A retailer without a lead row shows as a new, unscored retailer. */
export async function liveRetailersAndDeals(): Promise<{ retailers: Retailer[]; deals: Deal[] }> {
  const { supabase, orgId } = await ctx();
  const [r, l] = await Promise.all([
    supabase.from("retailers").select(RETAILER_COLS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(500),
    supabase.from("leads").select(LEAD_COLS).eq("org_id", orgId).order("last_activity_at", { ascending: false }).limit(500),
  ]);
  if (r.error) fail(r.error);
  if (l.error) fail(l.error);
  const retailers = (r.data ?? []) as RetailerRow[];
  const leads = (l.data ?? []) as LeadRow[];
  const byRetailer = new Map<string, LeadRow>(); // leads are newest first, so the first one seen per retailer is the latest
  for (const lead of leads) if (!byRetailer.has(lead.retailer_id)) byRetailer.set(lead.retailer_id, lead);
  const rows = new Map(retailers.map((x) => [x.id, x]));
  const n = await names(supabase, leads.map((x) => x.owner_id));
  return {
    retailers: retailers.map((x) => toRetailer(x, byRetailer.get(x.id))),
    deals: leads.flatMap((x) => { const rt = rows.get(x.retailer_id); return rt ? [toDeal(x, rt, n)] : []; }),
  };
}

/** Creates the retailer and its first lead (stage "new"). If the lead insert fails the retailer is kept and shows as new. */
export async function liveCreateRetailer(input: RetailerInput): Promise<Retailer> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("retailers").insert({ org_id: orgId, ...input }).select(RETAILER_COLS).single();
  if (error) fail(error);
  const retailer = data as RetailerRow;
  const lead = await supabase.from("leads").insert({ org_id: orgId, retailer_id: retailer.id, stage: "new" }).select(LEAD_COLS).single();
  await liveLog({ agent: "b2b", action: `Added retailer: ${input.business}` });
  return toRetailer(retailer, lead.error ? undefined : (lead.data as LeadRow));
}

export async function liveMoveDeal(id: string, stage: PipelineStage): Promise<Deal | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("leads").update({ stage, last_activity_at: new Date().toISOString() })
    .eq("org_id", orgId).eq("id", id).select(LEAD_COLS);
  if (error) fail(error);
  const lead = ((data ?? []) as LeadRow[])[0];
  if (!lead) return null;
  const { data: rt } = await supabase.from("retailers").select(RETAILER_COLS).eq("org_id", orgId).eq("id", lead.retailer_id).maybeSingle();
  if (!rt) return null;
  const n = await names(supabase, [lead.owner_id]);
  await liveLog({ agent: "crm", action: `Moved ${(rt as RetailerRow).business} to ${stage}` });
  return toDeal(lead, rt as RetailerRow, n);
}
