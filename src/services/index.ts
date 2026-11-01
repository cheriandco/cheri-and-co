/** Service boundary. Pages and API routes call these; components never touch
 *  mock data. To move to Supabase, re-implement the bodies here only. */
import * as m from "@/mocks/data";
import { authRequired } from "@/lib/auth/mode";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { isLiveOrg } from "@/lib/auth/access";
import { getAuthUser } from "@/lib/auth/session";
import { CONTENT_SAMPLE_NOTE, contentPacks, contentProducts } from "@/mocks/content-samples";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { runContentAgent, type ContentRunInput } from "@/lib/content-agent";
import { DISCOVERY_NOTE, discoveryCandidates, type DiscoveryCandidate } from "@/mocks/agent-samples";
import { amazonActionFor, buildSuggestions, followUpEmail, scoreCandidate, suggestedReplyFor, temperatureFor, type Suggestion } from "@/lib/agent-logic";
import { AGENT_NAMES } from "@/lib/agents";
import { renderDraft } from "@/lib/content-agent/render";
import { liveCreateTask, liveDecideApproval, liveUpdateTask } from "./live";
import { readStore, writableStore, type Store } from "./store";
import type {
  Activity, AgentKey, Approval, AuditEntry, Conversation, Customer, DashboardSummary, Deal, PipelineStage,
  ReportSection, Retailer, Task,
} from "@/types";
import type { ContentDraft } from "@/types/content-agent";
import type { SocialPost, SocialPostInput, SocialPostView } from "@/types/social";
import { addDays, isoDate, renderPostForApproval, sampleMetricsFor, toView } from "@/lib/social/posts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Sample records belong to the demo only. A live organisation gets `empty` instead, so sample and real data never mix. */
async function sampleOr<T>(empty: T, real: () => T | Promise<T>): Promise<T> {
  return (await isLiveOrg()) ? empty : real();
}

const RANGE_FACTOR: Record<string, number> = { today: 0.14, "7d": 1, "30d": 4.1, "90d": 11.5, custom: 1 };
const SCALED = new Set(["b2c", "b2b", "opp", "content"]);

export async function getDashboardSummary(range = "7d"): Promise<DashboardSummary> {
  await tick();
  const store = await readStore();
  if (await isLiveOrg()) {
    return {
      kpis: [], funnel: [], trend: { "7d": [], "30d": [], "90d": [] }, agents: [], enquiries: [], retailers: [], content: [], amazon: [],
      approvals: store.approvals.filter((a) => a.status === "pending").slice(0, 3),
      tasks: store.tasks.filter((t) => t.status === "open").slice(0, 4),
    };
  }
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
    retailers: store.retailers.slice(0, 5),
    content: m.contentItems.slice(0, 5),
    approvals: store.approvals.filter((a) => a.status === "pending").slice(0, 3),
    amazon: m.amazonRows.slice(0, 4),
    tasks: store.tasks.filter((t) => t.status === "open").slice(0, 4),
  };
}

export async function getCurrentUser() {
  if (!authRequired()) return m.currentUser;
  const u = await getAuthUser();
  return { name: u?.name ?? "Guest", role: u?.role ? ROLE_LABEL[u.role] : "No role assigned", email: u?.email ?? "" };
}
export async function getAgents() { await tick(); return sampleOr([], () => m.agents); }
export async function getEnquiries() { await tick(); return sampleOr([], () => m.enquiries); }
export async function getConversations(): Promise<Conversation[]> { await tick(); return sampleOr([], () => m.conversations); }
export async function getCustomers(): Promise<Customer[]> { await tick(); return sampleOr([], () => m.customers); }
export async function getCustomer(id: string) { await tick(); return sampleOr(null, () => m.customers.find((c) => c.id === id) ?? null); }
export async function getRetailers(): Promise<Retailer[]> { await tick(); return (await readStore()).retailers; }
export async function getRetailer(id: string) { await tick(); return (await readStore()).retailers.find((r) => r.id === id) ?? null; }
export async function getProducts() { await tick(); return sampleOr([], () => m.products); }
export async function getContent() { await tick(); return sampleOr([], () => m.contentItems); }
export async function getBrandRules() { await tick(); return sampleOr([], () => m.brandRules); }
export async function getNotifications() { await tick(); return sampleOr([], () => m.notifications); }
export async function getActivities(): Promise<Activity[]> { await tick(); return (await readStore()).activity; }

/** Records what an agent or a person did, newest first, so every agent shows up in one shared history. */
function logActivity(s: Store, entry: Omit<Activity, "id" | "at">) {
  s.activity.unshift({ id: `ac-${crypto.randomUUID().slice(0, 8)}`, at: "Just now", ...entry });
  if (s.activity.length > 200) s.activity.length = 200;
}
export async function getAmazon() {
  await tick();
  return sampleOr({ rows: [], competitors: [], reviews: [], pricing: [], listings: [] },
    () => ({ rows: m.amazonRows, competitors: m.amazonCompetitors, reviews: m.amazonReviews, pricing: m.amazonPricing, listings: m.amazonListings }));
}

export async function getTasks(): Promise<Task[]> { await tick(); return (await readStore()).tasks; }
export async function createTask(input: Pick<Task, "title" | "due" | "priority" | "assignee">, from?: Pick<Task, "source" | "href">): Promise<Task> {
  if (await isLiveOrg()) return liveCreateTask(input, from);
  const t: Task = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, source: "Manual", status: "open", href: "/tasks", ...input, ...from };
  const s = await writableStore();
  s.tasks.unshift(t);
  logActivity(s, { actor: "Anika", text: `Created task: ${t.title}`, agent: "crm" });
  return t;
}
export async function updateTask(id: string, patch: Partial<Pick<Task, "status" | "due" | "assignee">>): Promise<Task | null> {
  if (await isLiveOrg()) return liveUpdateTask(id, patch);
  const t = (await writableStore()).tasks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  return t;
}

export async function getApprovals(): Promise<Approval[]> { await tick(); return (await readStore()).approvals; }
export async function getAuditLog(): Promise<AuditEntry[]> { return (await readStore()).audit; }
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
  if (await isLiveOrg()) return liveDecideApproval(id, action, note, edits); // actor = the signed-in user, set by the database
  const store = await writableStore();
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
  logActivity(store, { actor, text: `${action === "approve" ? "Approved (demo)" : action === "reject" ? "Rejected (demo)" : "Edited"}: ${a.title}`, agent: a.generatedBy });
  return { ok: true, approval: a };
}

export async function getContentSamples() {
  await tick();
  return sampleOr({ products: [], packs: [], note: CONTENT_SAMPLE_NOTE }, () => ({ products: contentProducts, packs: contentPacks, note: CONTENT_SAMPLE_NOTE }));
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
  const store = await writableStore();
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

/* ---------- Social media (Content & Marketing Agent). Demo only: nothing is ever posted anywhere. ---------- */

export async function getSocialPosts(): Promise<SocialPostView[]> {
  await tick();
  const s = await readStore();
  const today = new Date();
  return s.social.map((p) => toView(p, today, p.approvalId ? s.approvals.find((a) => a.id === p.approvalId)?.status : undefined));
}

export async function createSocialPost(input: SocialPostInput): Promise<SocialPost> {
  const { scheduledFor, ...rest } = input;
  const post: SocialPost = {
    id: `sp-${crypto.randomUUID().slice(0, 8)}`, ...rest, isSample: false, tone: "rose",
    scheduledFor: scheduledFor ?? isoDate(addDays(new Date(), 7)),
  };
  (await writableStore()).social.unshift(post);
  return post;
}

export type SocialResult =
  | { ok: true; post: SocialPostView }
  | { ok: false; reason: "not_found" | "invalid_state" | "prohibited_claims"; error: string; detail?: string[] };

const viewOf = (s: Awaited<ReturnType<typeof writableStore>>, p: SocialPost): SocialPostView =>
  toView(p, new Date(), p.approvalId ? s.approvals.find((a) => a.id === p.approvalId)?.status : undefined);

/** Edit is allowed while the post is a draft or was rejected. Editing resets it to a fresh draft. */
export async function updateSocialPost(id: string, input: SocialPostInput): Promise<SocialResult> {
  const s = await writableStore();
  const p = s.social.find((x) => x.id === id);
  if (!p) return { ok: false, reason: "not_found", error: "Post not found." };
  const status = viewOf(s, p).status;
  if (status !== "draft" && status !== "rejected") return { ok: false, reason: "invalid_state", error: "Only drafts and rejected posts can be edited." };
  const { scheduledFor, ...rest } = input;
  Object.assign(p, rest, scheduledFor ? { scheduledFor, dayOffset: undefined } : {});
  p.approvalId = undefined;
  p.seedStatus = "draft";
  return { ok: true, post: viewOf(s, p) };
}

/** Queues the post as a pending approval. The claim guard runs first, and nothing is published. */
export async function submitSocialPost(id: string): Promise<SocialResult> {
  const s = await writableStore();
  const p = s.social.find((x) => x.id === id);
  if (!p) return { ok: false, reason: "not_found", error: "Post not found." };
  if (viewOf(s, p).status !== "draft") return { ok: false, reason: "invalid_state", error: "Only drafts can be submitted for approval." };
  if (!p.caption.trim()) return { ok: false, reason: "invalid_state", error: "Add a caption before submitting." };
  const preview = renderPostForApproval(p);
  const violations = findProhibitedClaims(preview, []);
  if (violations.length) {
    return { ok: false, reason: "prohibited_claims", error: "The post contains wording that needs client-approved claims.", detail: violations.map((v) => `${v.label}: "${v.match}"`) };
  }
  const approval: Approval = {
    id: `a-${crypto.randomUUID().slice(0, 8)}`, title: `${p.title} · ${p.platform} post`, type: "Content", generatedBy: "content",
    created: "just now", status: "pending", preview, tone: "rose",
    meta: { kind: "content_draft", subject: p.title, isSample: true, allowedClaims: [] },
  };
  s.approvals.unshift(approval);
  p.approvalId = approval.id;
  logActivity(s, { actor: "Content & Marketing Agent", text: `Sent "${p.title}" (${p.platform}) for approval (simulated)`, agent: "content" });
  return { ok: true, post: viewOf(s, p) };
}

/** "Publishes" an approved post in the simulation only. No platform is contacted. */
export async function simulatePublishSocialPost(id: string): Promise<SocialResult> {
  const s = await writableStore();
  const p = s.social.find((x) => x.id === id);
  if (!p) return { ok: false, reason: "not_found", error: "Post not found." };
  if (viewOf(s, p).status !== "approved") return { ok: false, reason: "invalid_state", error: "Only approved posts can be simulated as published." };
  p.simulatedPublished = true;
  p.metrics = sampleMetricsFor(p.id);
  logActivity(s, { actor: "Anika", text: `Simulated publishing of "${p.title}" (${p.platform}). Nothing was posted.`, agent: "content" });
  return { ok: true, post: viewOf(s, p) };
}

export async function getDeals(): Promise<Deal[]> { await tick(); return (await readStore()).deals; }
export async function moveDeal(id: string, stage: PipelineStage): Promise<Deal | null> {
  const d = (await writableStore()).deals.find((x) => x.id === id);
  if (!d) return null;
  d.stage = stage;
  d.updated = "just now";
  logActivity(await writableStore(), { actor: "Anika", text: `Moved ${d.business} to ${stage}`, agent: "crm", ref: d.retailerId });
  const r = (await writableStore()).retailers.find((x) => x.id === d.retailerId);
  if (r) { r.stage = stage; r.lastActivity = "just now"; }
  return d;
}

export async function getReports(): Promise<ReportSection[]> {
  if (await isLiveOrg()) return []; // the report figures are illustrative samples
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
  if (await isLiveOrg()) return [];
  return [
    ...m.customers.map((c) => ({ label: c.name, hint: "Customer", href: `/customers/${c.id}` })),
    ...m.retailers.map((r) => ({ label: r.business, hint: "Retailer", href: `/retailers/${r.id}` })),
    ...m.products.map((p) => ({ label: p.name, hint: "Product", href: "/products" })),
  ];
}

/* ---------- Agent actions: suggestions queued for a human decision. Demo only: nothing is sent, posted or changed. ---------- */

export type QueueAgent = "b2c" | "b2b" | "amazon";
export type QueueResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "not_found" | "already_queued"; error: string };

/** The text is always rebuilt on the server from the sample records; the browser only names the record. */
export async function queueAgentAction(agent: QueueAgent, ref: string): Promise<QueueResult> {
  const s = await writableStore();
  const key = `${agent}:${ref}`;
  const prior = s.links[key] ? s.approvals.find((a) => a.id === s.links[key]) : undefined;
  if (prior?.status === "pending") return { ok: false, reason: "already_queued", error: "This is already waiting in Approvals." };

  let draft: Pick<Approval, "type" | "title" | "preview"> | null = null;
  let log = "";
  if (agent === "b2c") {
    const c = m.conversations.find((x) => x.id === ref);
    if (c) { draft = { type: "Instagram reply", title: `SAMPLE · Reply to ${c.customer}`, preview: suggestedReplyFor(c) }; log = `Drafted a reply to ${c.customer} (simulated, not sent)`; }
  } else if (agent === "b2b") {
    const r = s.retailers.find((x) => x.id === ref);
    if (r) { draft = { type: "B2B outreach", title: `SAMPLE · Follow-up email — ${r.business}`, preview: followUpEmail(r) }; log = `Drafted a follow-up email for ${r.business} (simulated, not sent)`; }
  } else {
    const row = m.amazonRows.find((x) => x.id === ref);
    if (row) { draft = amazonActionFor(row); log = `Proposed: ${row.recommendation} (simulated, nothing changed on Amazon)`; }
  }
  if (!draft) return { ok: false, reason: "not_found", error: "Record not found." };

  const approval: Approval = { id: `a-${crypto.randomUUID().slice(0, 8)}`, ...draft, generatedBy: agent, created: "just now", status: "pending", tone: "rose" };
  s.approvals.unshift(approval);
  s.links[key] = approval.id;
  logActivity(s, { actor: AGENT_NAMES[agent], text: log, agent, ref: agent === "b2b" ? ref : undefined });
  return { ok: true, approval };
}

/** For each "agent:ref" this visitor has queued: the approval and its current decision. */
export async function getActionLinks(): Promise<Record<string, { approvalId: string; status: Approval["status"] }>> {
  const s = await readStore();
  const out: Record<string, { approvalId: string; status: Approval["status"] }> = {};
  for (const [key, id] of Object.entries(s.links)) {
    const a = s.approvals.find((x) => x.id === id);
    if (a) out[key] = { approvalId: id, status: a.status };
  }
  return out;
}

/* ---------- B2B Lead Agent: SAMPLE retailer discovery ---------- */

export type DiscoveryRow = DiscoveryCandidate & { score: number; temperature: ReturnType<typeof temperatureFor>; added: boolean; factors: ReturnType<typeof scoreCandidate>["factors"] };

export async function getDiscovery(): Promise<{ note: string; candidates: DiscoveryRow[] }> {
  await tick();
  const s = await readStore();
  const live = await isLiveOrg();
  return {
    note: DISCOVERY_NOTE,
    candidates: (live ? [] : discoveryCandidates).map((c) => {
      const { score, factors } = scoreCandidate(c.signals);
      return { ...c, score, factors, temperature: temperatureFor(score), added: s.retailers.some((r) => r.id === `r-${c.id}`) };
    }),
  };
}

export type AddLeadResult = { ok: true; retailer: Retailer } | { ok: false; reason: "not_found" | "exists"; error: string };

export async function addDiscoveredRetailer(id: string): Promise<AddLeadResult> {
  const c = discoveryCandidates.find((x) => x.id === id);
  if (!c) return { ok: false, reason: "not_found", error: "Candidate not found." };
  const s = await writableStore();
  if (s.retailers.some((r) => r.id === `r-${c.id}`)) return { ok: false, reason: "exists", error: "Already added to your leads." };
  const { score } = scoreCandidate(c.signals);
  const stage = score >= 75 ? "qualified" : "new";
  const retailer: Retailer = {
    id: `r-${c.id}`, business: c.business, location: c.location, category: c.category, score, temperature: temperatureFor(score),
    status: stage === "qualified" ? "Qualified" : "New", lastActivity: "just now", contact: c.contact, email: "Not collected (sample)", phone: "Not collected (sample)",
    instagram: c.instagram || "Not found", website: c.website || "Not found", mapsUrl: "https://maps.google.com",
    qualification: "Added from the SAMPLE discovery list. Fit score comes from the rule-based factors shown on this page.", stage,
  };
  s.retailers.unshift(retailer);
  s.deals.unshift({ id: `d-${retailer.id}`, retailerId: retailer.id, business: retailer.business, location: retailer.location, stage, score, owner: "Anika", updated: "just now" });
  logActivity(s, { actor: AGENT_NAMES.b2b, text: `Qualified ${retailer.business} (score ${score}) from the sample discovery list`, agent: "b2b", ref: retailer.id });
  return { ok: true, retailer };
}

/* ---------- CRM & Sales Ops + Orchestrator ---------- */

export async function getSuggestions(): Promise<Suggestion[]> {
  const s = await readStore();
  return buildSuggestions({ tasks: s.tasks, deals: s.deals, retailers: s.retailers, approvals: s.approvals, amazon: (await isLiveOrg()) ? [] : m.amazonRows });
}

/** Turns a suggestion into a task. The suggestion is rebuilt on the server, so the browser only names it. */
export async function createTaskFromSuggestion(key: string): Promise<Task | null> {
  const sug = (await getSuggestions()).find((x) => x.key === key);
  if (!sug) return null;
  return createTask({ title: sug.title, due: sug.due, priority: sug.priority, assignee: "Anika" }, { source: AGENT_NAMES[sug.agent], href: sug.href });
}

export interface OrchestratorBrief {
  agents: { key: AgentKey; name: string; headline: string; pending: number; href: string }[];
  recommendations: Suggestion[];
  feed: Activity[];
  totals: { pending: number; openTasks: number; hotLeads: number };
}

/** One cross-agent summary. It only reads and recommends: every action still goes through a human. */
export async function getOrchestratorBrief(): Promise<OrchestratorBrief> {
  await tick();
  const s = await readStore();
  if (await isLiveOrg()) return liveBrief(s);
  const pending = (k: AgentKey) => s.approvals.filter((a) => a.status === "pending" && a.generatedBy === k).length;
  const hot = s.retailers.filter((r) => r.temperature === "HOT").length;
  const open = s.tasks.filter((t) => t.status === "open").length;
  const needsHuman = m.conversations.filter((c) => c.status === "needs_human" || c.status === "new").length;
  const top = [...m.amazonRows].sort((a, b) => b.opportunity - a.opportunity)[0];
  const inNegotiation = s.deals.filter((d) => d.stage === "negotiation").length;
  const agents: OrchestratorBrief["agents"] = [
    { key: "b2c", name: AGENT_NAMES.b2c, headline: `${needsHuman} enquiries need a reply or a human`, pending: pending("b2c"), href: "/b2c" },
    { key: "b2b", name: AGENT_NAMES.b2b, headline: `${hot} hot lead${hot === 1 ? "" : "s"}, ${s.retailers.length} retailers tracked`, pending: pending("b2b"), href: "/b2b" },
    { key: "amazon", name: AGENT_NAMES.amazon, headline: `Top opportunity: ${top.product} (score ${top.opportunity})`, pending: pending("amazon"), href: "/amazon" },
    { key: "content", name: AGENT_NAMES.content, headline: `${s.social.length} planned posts, ${pending("content")} awaiting approval`, pending: pending("content"), href: "/content" },
    { key: "crm", name: AGENT_NAMES.crm, headline: `${open} open task${open === 1 ? "" : "s"}, ${inNegotiation} deal${inNegotiation === 1 ? "" : "s"} in negotiation`, pending: pending("crm"), href: "/crm" },
  ];
  return {
    agents,
    recommendations: buildSuggestions({ tasks: s.tasks, deals: s.deals, retailers: s.retailers, approvals: s.approvals, amazon: m.amazonRows }).slice(0, 5),
    feed: s.activity.slice(0, 8),
    totals: { pending: s.approvals.filter((a) => a.status === "pending").length, openTasks: open, hotLeads: hot },
  };
}

/** What the orchestrator can honestly say for a live organisation: approvals and tasks come from the database, and
 *  every other agent says it is not connected yet instead of quoting sample numbers. */
function liveBrief(s: Store): OrchestratorBrief {
  const pending = (k: AgentKey) => s.approvals.filter((a) => a.status === "pending" && a.generatedBy === k).length;
  const open = s.tasks.filter((t) => t.status === "open").length;
  const hrefs: Record<AgentKey, string> = { b2c: "/b2c", b2b: "/b2b", amazon: "/amazon", content: "/content", crm: "/tasks" };
  const agents = (Object.keys(hrefs) as AgentKey[]).map((key) => ({
    key, name: AGENT_NAMES[key], href: hrefs[key], pending: pending(key),
    headline: key === "crm" ? `${open} open task${open === 1 ? "" : "s"}` : "Not connected to the database yet",
  }));
  return {
    agents,
    recommendations: buildSuggestions({ tasks: s.tasks, deals: s.deals, retailers: s.retailers, approvals: s.approvals, amazon: [] }).slice(0, 5),
    feed: s.activity.slice(0, 8),
    totals: { pending: s.approvals.filter((a) => a.status === "pending").length, openTasks: open, hotLeads: 0 },
  };
}
