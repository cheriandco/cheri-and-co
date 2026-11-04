/** Live data, read and written through the signed-in user's own Supabase session, so Row Level Security applies to
 *  every call. The organisation always comes from the verified session (`orgId`), never from a request. Used only for
 *  organisations that are not flagged is_demo. This covers tasks, approvals, the audit log, agent activity, customers, retailers and leads. */
import { cache } from "react";
import { AuthError, ConflictError } from "@/lib/auth/access";
import { getAuthUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { renderPostForApproval, toView } from "@/lib/social/posts";
import type { CustomerInput, OrderInput, ProductInput, RetailerInput } from "@/lib/validate";
import type { Activity, AgentKey, Approval, ApprovalStatus, AuditEntry, Customer, Deal, Order, OrderStatus, PipelineStage, Product, Retailer, Task } from "@/types";
import type { ReportSection } from "@/types";
import type { SocialPost, SocialPostInput, SocialPostView } from "@/types/social";
import {
  NON_PURCHASE_STATUSES, POSTPONE_LABEL, REVENUE_STATUS, SOCIAL_DB_PLATFORMS, salesReport, parseDue, toActivity, toApproval, toAudit, toCustomer, toDeal, toOrder, toProduct, toRetailer, toSocialPost, toTask,
  type ActivityRow, type ApprovalRow, type AuditRow, type ContentRow, type CustomerRow, type LeadRow, type OrderRow, type ProductRow, type RetailerRow, type TaskRow,
} from "./live-map";
import type { Store } from "./store";

export class LiveError extends Error {}

/** `quiet`: skip the per-record activity line. Used by CSV import, which writes one summary line instead. */
export interface WriteOptions { quiet?: boolean }

/** One activity line for a whole CSV import. */
export async function liveImportLog(resource: string, created: number): Promise<void> {
  if (created > 0) await liveLog({ agent: resource === "retailers" ? "b2b" : "crm", action: `Imported ${created} ${resource} from a CSV file` });
}

/** Rows fetched per request. The API answers with at most its own max-rows setting (1000 by default), so a plain `.limit(5000)` quietly
 *  returned 1000. Lists are therefore read page by page until they are complete. */
const PAGE_SIZE = 1000;
/** A list longer than this is refused with an error instead of being cut short, so a page never shows a quietly incomplete set. */
export const LIST_CAP = 10_000;

type PageResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

/** Reads every row of a query. `page(from, to)` must order by a unique, stable key so pages neither overlap nor skip. */
export async function allRows<T>(page: (from: number, to: number) => PageResult, cap = LIST_CAP): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) fail(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (out.length > cap) throw new LiveError("Too many records to list in one view");
    if (rows.length < PAGE_SIZE) return out;
  }
}

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
  const rows = await allRows<TaskRow>((from, to) => supabase.from("tasks").select("id, title, source, due_at, priority, status, assignee_id, related_ref")
    .eq("org_id", orgId).order("created_at", { ascending: false }).order("id").range(from, to));
  const n = await names(supabase, rows.map((r) => r.assignee_id));
  return rows.map((r) => toTask(r, n));
}

export async function liveCreateTask(input: Pick<Task, "title" | "due" | "priority">, from?: Pick<Task, "source" | "href">, opts: WriteOptions = {}): Promise<Task> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("tasks").insert({
    org_id: orgId, title: input.title, priority: input.priority, due_at: parseDue(input.due),
    source: from?.source ?? "Manual", related_ref: from?.href ?? null,
  }).select("id, title, source, due_at, priority, status, assignee_id, related_ref").single();
  if (error) fail(error);
  if (!opts.quiet) await liveLog({ agent: "crm", action: `Created task: ${input.title}` });
  return toTask(data as TaskRow, new Map());
}

export async function liveUpdateTask(id: string, patch: Partial<Pick<Task, "status" | "due" | "assignee">>): Promise<Task | null> {
  // The table stores a person's id, and the app has no way to pick a person yet, so say so instead of pretending the change was saved.
  if (patch.assignee !== undefined) throw new ConflictError("Assigning tasks to people is not available yet");
  const { supabase, orgId } = await ctx();
  const change: Record<string, unknown> = {};
  if (patch.status) change.status = patch.status;
  if (patch.due === POSTPONE_LABEL) {
    // "Postpone" means one day later than the current due date (or tomorrow when there is none), not "no due date".
    const { data: cur, error: curError } = await supabase.from("tasks").select("due_at").eq("org_id", orgId).eq("id", id).maybeSingle();
    if (curError) fail(curError);
    if (!cur) return null;
    const base = (cur as { due_at: string | null }).due_at ? new Date((cur as { due_at: string }).due_at) : new Date();
    change.due_at = new Date(base.getTime() + 86_400_000).toISOString();
  } else if (patch.due !== undefined) change.due_at = parseDue(patch.due);
  if (!Object.keys(change).length) return null;
  const { data, error } = await supabase.from("tasks").update(change).eq("org_id", orgId).eq("id", id)
    .select("id, title, source, due_at, priority, status, assignee_id, related_ref");
  if (error) fail(error);
  const row = ((data ?? []) as TaskRow[])[0];
  return row ? toTask(row, new Map()) : null;
}

export async function liveApprovals(): Promise<Approval[]> {
  const { supabase, orgId } = await ctx();
  const rows = await allRows<ApprovalRow>((from, to) => supabase.from("approvals").select("id, title, type, generated_by, status, preview, meta, created_at")
    .eq("org_id", orgId).order("created_at", { ascending: false }).order("id").range(from, to));
  return rows.map((r) => toApproval(r));
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
  if (action !== "edit") await syncContentStatus(supabase, orgId, id, action === "approve" ? "approved" : "rejected");
  await liveLog({ agent: approval.generatedBy, action: `${action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Edited"}: ${approval.title}` });
  return { ok: true, approval };
}

/** Keeps content_items.status in step with the decision on its approval. Best effort: the post's shown status follows the
 *  approval itself, so a failure here cannot make the calendar wrong. */
async function syncContentStatus(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], orgId: string, approvalId: string, status: "approved" | "rejected") {
  try { await supabase.from("content_items").update({ status }).eq("org_id", orgId).eq("approval_id", approvalId); } catch { /* see above */ }
}

export async function liveAudit(): Promise<AuditEntry[]> {
  const { supabase, orgId } = await ctx();
  const rows = (await allRows<AuditRow>((from, to) => supabase.from("audit_log").select("id, approval_id, action, actor_id, note, at")
    .eq("org_id", orgId).order("at", { ascending: false }).order("id", { ascending: false }).range(from, to))).reverse(); // oldest first, like the sample store: the Approvals page reverses it
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

/** A customer's purchases are their orders other than cancelled and returned ones (see NON_PURCHASE_STATUSES). */
async function purchaseCounts(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], orgId: string): Promise<Map<string, number>> {
  const orders = await allRows<{ customer_id: string }>((from, to) => supabase.from("orders").select("customer_id").eq("org_id", orgId).not("customer_id", "is", null)
    .not("status", "in", `(${NON_PURCHASE_STATUSES.join(",")})`).order("id").range(from, to));
  const out = new Map<string, number>();
  for (const o of orders) out.set(o.customer_id, (out.get(o.customer_id) ?? 0) + 1);
  return out;
}

export async function liveCustomers(): Promise<Customer[]> {
  const { supabase, orgId } = await ctx();
  const rows = await allRows<CustomerRow>((from, to) => supabase.from("customers").select(CUSTOMER_COLS).eq("org_id", orgId)
    .order("created_at", { ascending: false }).order("id").range(from, to));
  const counts = await purchaseCounts(supabase, orgId);
  return rows.map((r) => toCustomer(r, counts.get(r.id) ?? 0));
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

export async function liveCreateCustomer(input: CustomerInput, opts: WriteOptions = {}): Promise<Customer> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("customers").insert({ org_id: orgId, ...input }).select(CUSTOMER_COLS).single();
  if (error) fail(error);
  if (!opts.quiet) await liveLog({ agent: "crm", action: `Added customer: ${input.name}` });
  return toCustomer(data as CustomerRow, 0);
}

/** Replaces the editable fields of a customer. null when the customer does not exist in this organisation. */
export async function liveUpdateCustomer(id: string, input: CustomerInput): Promise<Customer | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("customers").update(input).eq("org_id", orgId).eq("id", id).select(CUSTOMER_COLS);
  if (error) fail(error);
  const row = ((data ?? []) as CustomerRow[])[0];
  if (!row) return null;
  await liveLog({ agent: "crm", action: `Updated customer: ${input.name}` });
  const counts = await purchaseCounts(supabase, orgId);
  return toCustomer(row, counts.get(id) ?? 0);
}

/** Retailers with their lead. A retailer without a lead row shows as a new, unscored retailer. */
export async function liveRetailersAndDeals(): Promise<{ retailers: Retailer[]; deals: Deal[] }> {
  const { supabase, orgId } = await ctx();
  const [retailers, leads] = await Promise.all([
    allRows<RetailerRow>((from, to) => supabase.from("retailers").select(RETAILER_COLS).eq("org_id", orgId).order("created_at", { ascending: false }).order("id").range(from, to)),
    allRows<LeadRow>((from, to) => supabase.from("leads").select(LEAD_COLS).eq("org_id", orgId).order("last_activity_at", { ascending: false }).order("id").range(from, to)),
  ]);
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
export async function liveCreateRetailer(input: RetailerInput, opts: WriteOptions = {}): Promise<Retailer> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("retailers").insert({ org_id: orgId, ...input }).select(RETAILER_COLS).single();
  if (error) fail(error);
  const retailer = data as RetailerRow;
  const lead = await supabase.from("leads").insert({ org_id: orgId, retailer_id: retailer.id, stage: "new" }).select(LEAD_COLS).single();
  if (!opts.quiet) await liveLog({ agent: "b2b", action: `Added retailer: ${input.business}` });
  return toRetailer(retailer, lead.error ? undefined : (lead.data as LeadRow));
}

/** Replaces the editable fields of a retailer. The lead (stage, score) is not touched. null when the retailer is not in this organisation. */
export async function liveUpdateRetailer(id: string, input: RetailerInput): Promise<Retailer | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("retailers").update(input).eq("org_id", orgId).eq("id", id).select(RETAILER_COLS);
  if (error) fail(error);
  const row = ((data ?? []) as RetailerRow[])[0];
  if (!row) return null;
  const leads = await supabase.from("leads").select(LEAD_COLS).eq("org_id", orgId).eq("retailer_id", id).order("last_activity_at", { ascending: false }).limit(1);
  await liveLog({ agent: "b2b", action: `Updated retailer: ${input.business}` });
  return toRetailer(row, leads.error ? undefined : ((leads.data ?? []) as LeadRow[])[0]);
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

/* ---------- Products ---------- */

const PRODUCT_COLS = "id, sku, name, category, price, stock, status, channels, created_at";

/** Postgres unique_violation: the (org_id, sku) constraint. */
const isDuplicate = (error: { code?: string; message: string }) => error.code === "23505" || /duplicate key/i.test(error.message);

export async function liveProducts(): Promise<Product[]> {
  const { supabase, orgId } = await ctx();
  const rows = await allRows<ProductRow>((from, to) => supabase.from("products").select(PRODUCT_COLS).eq("org_id", orgId)
    .order("created_at", { ascending: false }).order("id").range(from, to));
  return rows.map(toProduct);
}

export async function liveProduct(id: string): Promise<Product | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("products").select(PRODUCT_COLS).eq("org_id", orgId).eq("id", id).maybeSingle();
  if (error) fail(error);
  return data ? toProduct(data as ProductRow) : null;
}

export async function liveCreateProduct(input: ProductInput): Promise<Product> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("products").insert({ org_id: orgId, ...input }).select(PRODUCT_COLS).single();
  if (error) {
    if (isDuplicate(error)) throw new ConflictError("A product with this SKU already exists");
    fail(error);
  }
  await liveLog({ agent: "content", action: `Added product: ${input.name}` });
  return toProduct(data as ProductRow);
}

export async function liveUpdateProduct(id: string, input: ProductInput): Promise<Product | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("products").update(input).eq("org_id", orgId).eq("id", id).select(PRODUCT_COLS);
  if (error) {
    if (isDuplicate(error)) throw new ConflictError("A product with this SKU already exists");
    fail(error);
  }
  const row = ((data ?? []) as ProductRow[])[0];
  if (!row) return null;
  await liveLog({ agent: "content", action: `Updated product: ${input.name}` });
  return toProduct(row);
}

/* ---------- Content calendar / social posts (content_items) ---------- */

const CONTENT_COLS = "id, platform, title, topic, caption, hashtags, creative_brief, image_direction, scheduled_for, status, approval_id, created_at";

/** A post's status follows its approval; the content_items.status column is kept in step but is only the fallback. */
/** An approval and the post it was raised for. `postId` is written into the approval's meta at submit time. */
type ApprovalLink = { status: ApprovalStatus; postId?: string };

async function approvalStatuses(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], orgId: string, rows: ContentRow[]): Promise<Map<string, ApprovalLink>> {
  const ids = [...new Set(rows.map((r) => r.approval_id).filter((x): x is string => !!x))];
  const out = new Map<string, ApprovalLink>();
  if (!ids.length) return out;
  const { data, error } = await supabase.from("approvals").select("id, status, meta").eq("org_id", orgId).in("id", ids);
  if (error) fail(error); // an unreadable approval must not leave a post looking approved
  for (const a of (data ?? []) as { id: string; status: ApprovalStatus; meta: { postId?: unknown } | null }[])
    out.set(a.id, { status: a.status, postId: typeof a.meta?.postId === "string" ? a.meta.postId : undefined });
  return out;
}

/** A post counts as approved or rejected only when an approval raised for this very post says so. Writers can update `content_items`
 *  directly (the table's policy allows it), so the stored status or approval_id alone is never trusted: a post whose status was set by hand,
 *  or that points at some other item's approval, is shown as a draft. */
const viewFor = (r: ContentRow, links: Map<string, ApprovalLink>): SocialPostView => {
  const link = r.approval_id ? links.get(r.approval_id) : undefined;
  const backed = !!link && link.postId === r.id;
  const post = toSocialPost(r);
  return backed ? toView(post, new Date(), link.status) : toView({ ...post, approvalId: undefined, seedStatus: "draft" }, new Date());
};

export async function liveSocialPosts(): Promise<SocialPostView[]> {
  const { supabase, orgId } = await ctx();
  const rows = await allRows<ContentRow>((from, to) => supabase.from("content_items").select(CONTENT_COLS).eq("org_id", orgId)
    .in("platform", [...SOCIAL_DB_PLATFORMS]).order("created_at", { ascending: false }).order("id").range(from, to));
  const statuses = await approvalStatuses(supabase, orgId, rows);
  return rows.map((r) => viewFor(r, statuses));
}

async function loadPost(id: string) {
  const { supabase, orgId } = await ctx();
  if (!UUID.test(id)) return { supabase, orgId, row: null, view: null };
  const { data, error } = await supabase.from("content_items").select(CONTENT_COLS).eq("org_id", orgId).eq("id", id)
    .in("platform", [...SOCIAL_DB_PLATFORMS]).maybeSingle();
  if (error) fail(error);
  const row = (data as ContentRow | null) ?? null;
  return { supabase, orgId, row, view: row ? viewFor(row, await approvalStatuses(supabase, orgId, [row])) : null };
}

const contentColumns = (input: SocialPostInput) => ({
  platform: input.platform, title: input.title, topic: input.topic || null, caption: input.caption || null, hashtags: input.hashtags,
  creative_brief: input.creativeBrief || null, image_direction: input.imageDirection || null,
});

/** A new post is always a draft. The planned date defaults to a week from today, like the demo. */
export async function liveCreateSocialPost(input: SocialPostInput, defaultDate: string): Promise<SocialPost> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("content_items")
    .insert({ org_id: orgId, ...contentColumns(input), scheduled_for: input.scheduledFor ?? defaultDate, status: "draft" }).select(CONTENT_COLS).single();
  if (error) fail(error);
  await liveLog({ agent: "content", action: `Drafted post: ${input.title}` });
  return toSocialPost(data as ContentRow);
}

export type LivePostResult =
  | { ok: true; post: SocialPostView }
  | { ok: false; reason: "not_found" | "invalid_state" | "prohibited_claims"; error: string; detail?: string[] };

/** Only drafts and rejected posts can be edited. Editing makes it a fresh draft with no approval attached. */
export async function liveUpdateSocialPost(id: string, input: SocialPostInput): Promise<LivePostResult> {
  const { supabase, orgId, row, view } = await loadPost(id);
  if (!row || !view) return { ok: false, reason: "not_found", error: "Post not found." };
  if (view.status !== "draft" && view.status !== "rejected") return { ok: false, reason: "invalid_state", error: "Only drafts and rejected posts can be edited." };
  const change = { ...contentColumns(input), status: "draft", approval_id: null, ...(input.scheduledFor ? { scheduled_for: input.scheduledFor } : {}) };
  const { data, error } = await supabase.from("content_items").update(change).eq("org_id", orgId).eq("id", id).select(CONTENT_COLS);
  if (error) fail(error);
  const saved = ((data ?? []) as ContentRow[])[0];
  if (!saved) return { ok: false, reason: "not_found", error: "Post not found." };
  return { ok: true, post: viewFor(saved, new Map()) };
}

/** Claims the draft first (so a double click cannot queue it twice), then queues a pending approval and links it.
 *  The claim guard runs before anything is written. Nothing is published. */
export async function liveSubmitSocialPost(id: string): Promise<LivePostResult> {
  const { supabase, orgId, row, view } = await loadPost(id);
  if (!row || !view) return { ok: false, reason: "not_found", error: "Post not found." };
  if (view.status !== "draft") return { ok: false, reason: "invalid_state", error: "Only drafts can be submitted for approval." };
  if (!view.caption.trim()) return { ok: false, reason: "invalid_state", error: "Add a caption before submitting." };
  const preview = renderPostForApproval(view);
  const violations = findProhibitedClaims(preview, []);
  if (violations.length) {
    return { ok: false, reason: "prohibited_claims", error: "The post contains wording that needs client-approved claims.", detail: violations.map((v) => `${v.label}: "${v.match}"`) };
  }
  const claim = await supabase.from("content_items").update({ status: "pending_approval" }).eq("org_id", orgId).eq("id", id).eq("status", "draft").select("id");
  if (claim.error) fail(claim.error);
  if (!((claim.data ?? []) as unknown[]).length) return { ok: false, reason: "invalid_state", error: "Only drafts can be submitted for approval." };
  const made = await supabase.from("approvals").insert({
    org_id: orgId, title: `${view.title} · ${view.platform} post`, type: "Content", generated_by: "content", status: "pending", preview,
    meta: { kind: "content_draft", subject: view.title, isSample: false, allowedClaims: [], postId: id },
  }).select("id").single();
  if (made.error || !made.data) {
    await supabase.from("content_items").update({ status: "draft" }).eq("org_id", orgId).eq("id", id); // put it back so it can be retried
    fail(made.error ?? { message: "Database request failed" });
  }
  const approvalId = (made.data as { id: string }).id;
  const link = await supabase.from("content_items").update({ approval_id: approvalId }).eq("org_id", orgId).eq("id", id).select(CONTENT_COLS);
  const saved = ((link.data ?? []) as ContentRow[])[0];
  if (link.error || !saved) {
    await undoSubmit(supabase, orgId, id, approvalId);
    if (link.error) fail(link.error);
    return { ok: false, reason: "not_found", error: "Post not found." };
  }
  await liveLog({ agent: "content", action: `Sent "${view.title}" (${view.platform}) for approval` });
  return { ok: true, post: viewFor(saved, new Map<string, ApprovalLink>([[approvalId, { status: "pending", postId: id }]])) };
}

/** The approval was created but could not be linked to its post. The database allows no delete or update of approvals, so
 *  this uses only what is already permitted: put the post back to a draft (it can be resubmitted), and, if the caller may
 *  decide approvals, reject the unlinked approval through decide_approval() so it does not sit in the queue. Anyone else
 *  (staff) leaves a pending approval that no post points to; approving it does nothing. Best effort. */
async function undoSubmit(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], orgId: string, postId: string, approvalId: string) {
  try { await supabase.from("content_items").update({ status: "draft" }).eq("org_id", orgId).eq("id", postId); } catch { /* see above */ }
  try {
    await supabase.rpc("decide_approval", { p_id: approvalId, p_action: "reject", p_note: "Not linked to a post: the submission failed. Please resubmit.", p_title: null, p_preview: null });
  } catch { /* the caller may not be allowed to decide */ }
}

/* ---------- Orders ---------- */

const ORDER_COLS = "id, customer_id, retailer_id, channel, status, total, line_items, ordered_at";
const isForeignKey = (error: { code?: string; message: string }) => error.code === "23503" || /foreign key/i.test(error.message);

export async function liveOrders(): Promise<Order[]> {
  const { supabase, orgId } = await ctx();
  const rows = await allRows<OrderRow>((from, to) => supabase.from("orders").select(ORDER_COLS).eq("org_id", orgId)
    .order("ordered_at", { ascending: false }).order("id").range(from, to));
  return rows.map(toOrder);
}

export async function liveOrder(id: string): Promise<Order | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("orders").select(ORDER_COLS).eq("org_id", orgId).eq("id", id).maybeSingle();
  if (error) fail(error);
  return data ? toOrder(data as OrderRow) : null;
}

/** A customer or retailer from another organisation is refused by the database's composite foreign key (org_id, id). */
export async function liveCreateOrder(input: OrderInput, opts: WriteOptions = {}): Promise<Order> {
  const { supabase, orgId } = await ctx();
  const row = {
    org_id: orgId, customer_id: input.customerId, retailer_id: input.retailerId, channel: input.channel, status: input.status,
    total: input.total, line_items: input.lineItems, ...(input.orderedAt ? { ordered_at: input.orderedAt } : {}),
  };
  const { data, error } = await supabase.from("orders").insert(row).select(ORDER_COLS).single();
  if (error) {
    if (isForeignKey(error)) throw new ConflictError("Unknown customer or retailer");
    fail(error);
  }
  if (!opts.quiet) await liveLog({ action: `Recorded a ${input.channel} order` });
  return toOrder(data as OrderRow);
}

export async function liveUpdateOrderStatus(id: string, status: OrderStatus): Promise<Order | null> {
  if (!UUID.test(id)) return null;
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("orders").update({ status }).eq("org_id", orgId).eq("id", id).select(ORDER_COLS);
  if (error) fail(error);
  const row = ((data ?? []) as OrderRow[])[0];
  if (!row) return null;
  await liveLog({ action: `Marked an order ${status}` });
  return toOrder(row);
}

/** The Sales report: delivered orders only, last twelve weeks (six shown, six for comparison). Every matching row is read page by page;
 *  beyond LIST_CAP rows that is an error instead of a quietly short total. */
export async function liveSalesReport(now = new Date()): Promise<ReportSection> {
  const { supabase, orgId } = await ctx();
  const since = new Date(now.getTime() - 12 * 7 * 86_400_000).toISOString();
  const rows = await allRows<{ total: number | string; ordered_at: string }>((from, to) => supabase.from("orders").select("total, ordered_at").eq("org_id", orgId)
    .eq("status", REVENUE_STATUS).gte("ordered_at", since).order("id").range(from, to));
  return salesReport(rows, now);
}
