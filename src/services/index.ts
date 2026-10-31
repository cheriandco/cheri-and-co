/** Service boundary. Pages and API routes call these; components never touch
 *  mock data. To move to Supabase, re-implement the bodies here only. */
import * as m from "@/mocks/data";
import { CONTENT_SAMPLE_NOTE, contentPacks, contentProducts } from "@/mocks/content-samples";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { runContentAgent, type ContentRunInput } from "@/lib/content-agent";
import { renderDraft } from "@/lib/content-agent/render";
import { store } from "./store";
import type {
  Approval, AuditEntry, Conversation, Customer, DashboardSummary, Deal, PipelineStage,
  ReportSection, Retailer, Task,
} from "@/types";
import type { ContentDraft } from "@/types/content-agent";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const RANGE_FACTOR: Record<string, number> = { today: 0.14, "7d": 1, "30d": 4.1, "90d": 11.5, custom: 1 };
const SCALED = new Set(["b2c", "b2b", "opp", "content"]);

export async function getDashboardSummary(range = "7d"): Promise<DashboardSummary> {
  await tick();
  const f = RANGE_FACTOR[range] ?? 1;
  return {
    kpis: m.kpis.map((k) =>
      k.id === "appr" ? { ...k, value: store.approvals.filter((a) => a.status === "pending").length }
      : SCALED.has(k.id) ? { ...k, value: Math.max(1, Math.round(k.value * f)) }
      : k),
    funnel: m.funnel,
    trend: m.trend,
    agents: m.agents,
    enquiries: m.enquiries,
    retailers: m.retailers.slice(0, 5),
    content: m.contentItems.slice(0, 5),
    approvals: store.approvals.filter((a) => a.status === "pending").slice(0, 3),
    amazon: m.amazonRows.slice(0, 4),
    tasks: store.tasks.filter((t) => t.status === "open").slice(0, 4),
  };
}

export async function getCurrentUser() { return m.currentUser; }
export async function getAgents() { await tick(); return m.agents; }
export async function getEnquiries() { await tick(); return m.enquiries; }
export async function getConversations(): Promise<Conversation[]> { await tick(); return m.conversations; }
export async function getCustomers(): Promise<Customer[]> { await tick(); return m.customers; }
export async function getCustomer(id: string) { await tick(); return m.customers.find((c) => c.id === id) ?? null; }
export async function getRetailers(): Promise<Retailer[]> { await tick(); return m.retailers; }
export async function getRetailer(id: string) { await tick(); return m.retailers.find((r) => r.id === id) ?? null; }
export async function getProducts() { await tick(); return m.products; }
export async function getContent() { await tick(); return m.contentItems; }
export async function getBrandRules() { await tick(); return m.brandRules; }
export async function getNotifications() { await tick(); return m.notifications; }
export async function getActivities() { await tick(); return m.activities; }
export async function getAmazon() {
  await tick();
  return { rows: m.amazonRows, competitors: m.amazonCompetitors, reviews: m.amazonReviews, pricing: m.amazonPricing, listings: m.amazonListings };
}

export async function getTasks(): Promise<Task[]> { await tick(); return store.tasks; }
export async function createTask(input: Pick<Task, "title" | "due" | "priority" | "assignee">): Promise<Task> {
  const t: Task = { id: `t${Date.now()}`, source: "Manual", status: "open", href: "/tasks", ...input };
  store.tasks.unshift(t);
  return t;
}
export async function updateTask(id: string, patch: Partial<Pick<Task, "status" | "due" | "assignee">>): Promise<Task | null> {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  return t;
}

export async function getApprovals(): Promise<Approval[]> { await tick(); return store.approvals; }
export async function getAuditLog(): Promise<AuditEntry[]> { return store.audit; }
export type DecisionResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "not_found" | "not_pending" | "prohibited_claims"; detail?: string[] };

/** Records a human decision. Only pending approvals can be decided, and failed attempts write no audit entry.
 *  Approving never executes, sends or publishes anything: status simply becomes "approved". */
export async function decideApproval(
  id: string,
  action: "approve" | "reject" | "edit",
  actor: string,
  note?: string,
  edits?: { title?: string; preview?: string },
): Promise<DecisionResult> {
  const a = store.approvals.find((x) => x.id === id);
  if (!a) return { ok: false, reason: "not_found" };
  if (a.status !== "pending") return { ok: false, reason: "not_pending" };
  if (action === "approve" && a.meta?.kind === "content_draft") {
    const violations = findProhibitedClaims(a.preview, a.meta.allowedClaims);
    if (violations.length) return { ok: false, reason: "prohibited_claims", detail: violations.map((v) => `${v.label}: "${v.match}"`) };
  }
  if (action === "approve") a.status = "approved";
  if (action === "reject") a.status = "rejected";
  if (action === "edit") Object.assign(a, edits);
  store.audit.push({ id: `au${Date.now()}`, approvalId: id, action, actor, at: new Date().toISOString(), note });
  return { ok: true, approval: a };
}

export async function getContentSamples() {
  await tick();
  return { products: contentProducts, packs: contentPacks, note: CONTENT_SAMPLE_NOTE };
}

export type SubmitResult =
  | { ok: true; approval: Approval; draft: ContentDraft }
  | { ok: false; reason: "invalid" | "blocked" | "duplicate"; error: string; draft?: ContentDraft };

/** Regenerates the draft on the server (the browser's copy is never trusted) and queues it as "Pending review".
 *  Nothing is published: the queue entry is a request for a human decision. */
export async function submitContentDraft(input: ContentRunInput): Promise<SubmitResult> {
  const run = runContentAgent(input, contentProducts, contentPacks);
  if (!run.ok) return { ok: false, reason: "invalid", error: run.error };
  const { draft } = run;
  if (draft.blocked) return { ok: false, reason: "blocked", error: "The draft has blocking issues and cannot be submitted.", draft };
  const preview = renderDraft(draft);
  const title = `${draft.subject.name} · content pack`;
  if (store.approvals.some((x) => x.status === "pending" && x.title === title && x.preview === preview))
    return { ok: false, reason: "duplicate", error: "An identical draft is already waiting for review.", draft };
  const approval: Approval = {
    id: `a-${crypto.randomUUID().slice(0, 8)}`, title, type: "Content", generatedBy: "content", created: "just now",
    status: "pending", preview, tone: "rose",
    meta: { kind: "content_draft", subject: draft.subject.name, isSample: draft.subject.isSample, allowedClaims: contentClaimsFor(input) },
  };
  store.approvals.unshift(approval);
  return { ok: true, approval, draft };
}

function contentClaimsFor(input: ContentRunInput): string[] {
  const t = input.target;
  const rec = t.type === "product" ? contentProducts.find((x) => x.id === t.id) : contentPacks.find((x) => x.id === t.id);
  return rec ? [...rec.approvedClaims] : [];
}

export async function getDeals(): Promise<Deal[]> { await tick(); return store.deals; }
export async function moveDeal(id: string, stage: PipelineStage): Promise<Deal | null> {
  const d = store.deals.find((x) => x.id === id);
  if (!d) return null;
  d.stage = stage;
  d.updated = "just now";
  return d;
}

export async function getReports(): Promise<ReportSection[]> {
  await tick();
  const s = (label: string, seriesTitle: string, vals: number[], metrics: ReportSection["metrics"]): ReportSection => ({
    id: label.toLowerCase().replace(/[^a-z]+/g, "-"),
    label,
    metrics,
    seriesTitle,
    series: ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"].map((l, i) => ({ label: l, value: vals[i] })),
  });
  return [
    s("Sales", "Revenue by week (₹ thousand)", [182, 204, 198, 236, 251, 289], [{ label: "Revenue", value: "₹12.6L", change: 14.2 }, { label: "Orders", value: "1,184", change: 9.8 }, { label: "AOV", value: "₹1,064", change: 3.9 }]),
    s("B2C", "Enquiries by week", [310, 342, 365, 401, 429, 482], [{ label: "Enquiries", value: "482", change: 12.4 }, { label: "AI resolved", value: "78%", change: 4.1 }, { label: "Avg reply", value: "38s", change: -22 }]),
    s("B2B", "New retailer leads by week", [9, 11, 8, 14, 12, 17], [{ label: "Leads", value: "67", change: 8.1 }, { label: "Qualified", value: "42", change: 11.0 }, { label: "Won", value: "11", change: 22.2 }]),
    s("Content", "Assets produced by week", [14, 18, 21, 25, 29, 34], [{ label: "Generated", value: "126", change: 31.2 }, { label: "Approval rate", value: "86%", change: 2.4 }, { label: "Avg engagement", value: "6.4%", change: 0.8 }]),
    s("Amazon", "Opportunity score (avg)", [58, 60, 63, 61, 66, 69], [{ label: "Opportunities", value: "18", change: -5.3 }, { label: "Avg score", value: "69", change: 4.5 }, { label: "Price gaps", value: "3", change: 0 }]),
    s("AI Agents", "Agent actions by week", [610, 702, 744, 801, 866, 940], [{ label: "Actions", value: "4,663", change: 15.3 }, { label: "Needs human", value: "9%", change: -1.2 }, { label: "Errors", value: "0.4%", change: -0.3 }]),
    s("Operations", "Tasks completed by week", [21, 26, 24, 33, 31, 38], [{ label: "Tasks done", value: "173", change: 7.6 }, { label: "Overdue", value: "4", change: -2 }, { label: "Avg time to close", value: "1.4d", change: -9.1 }]),
  ];
}

export async function getSearchIndex() {
  return [
    ...m.customers.map((c) => ({ label: c.name, hint: "Customer", href: `/customers/${c.id}` })),
    ...m.retailers.map((r) => ({ label: r.business, hint: "Retailer", href: `/retailers/${r.id}` })),
    ...m.products.map((p) => ({ label: p.name, hint: "Product", href: "/products" })),
  ];
}
