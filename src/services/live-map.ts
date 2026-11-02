/** Pure mapping between database rows and the app's types. No I/O, so it is tested without a database.
 *  The database uses UUIDs, timestamps and enums; the UI types carry display strings such as "Today". */
import { temperatureFor } from "@/lib/agent-logic";
import { ORDER_CHANNELS, ORDER_STATUSES } from "@/types";
import type { ReportSection } from "@/types";
import type { Activity, AgentKey, Approval, AuditEntry, Customer, Deal, Order, PipelineStage, Priority, Product, Retailer, Task, Temperature } from "@/types";
import type { SocialPlatform, SocialPost, SocialStatus } from "@/types/social";

export interface TaskRow { id: string; title: string; source: string; due_at: string | null; priority: string; status: string; assignee_id: string | null; related_ref: string | null }
export interface ApprovalRow { id: string; title: string; type: string; generated_by: string; status: string; preview: string; meta: unknown; created_at: string }
export interface AuditRow { id: number; approval_id: string; action: string; actor_id: string; note: string | null; at: string }
export interface ActivityRow { id: number; agent: string | null; action: string; ref_id: string | null; actor_id: string | null; created_at: string }

const AGENTS: readonly string[] = ["b2c", "b2b", "amazon", "content", "crm"];
const isAgent = (v: string | null): v is AgentKey => v !== null && AGENTS.includes(v);

export function ago(iso: string, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function dueLabel(iso: string | null, now = new Date()): string {
  if (!iso) return "Unscheduled";
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return "Today";
  const tomorrow = new Date(now.getTime() + 86400000);
  if (dayKey(d) === dayKey(tomorrow)) return "Tomorrow";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** The UI lets people type "Today", "Tomorrow", "This week" or an ISO date; the database stores a timestamp.
 *  Anything else (including "Unscheduled") becomes no due date. */
export function parseDue(text: string | undefined | null, now = new Date()): string | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t || t === "unscheduled") return null;
  const at = (days: number) => { const d = new Date(now.getTime() + days * 86400000); d.setHours(17, 0, 0, 0); return d.toISOString(); };
  if (t === "today") return at(0);
  if (t === "tomorrow") return at(1);
  if (t === "this week") return at(7 - ((now.getDay() + 6) % 7) - 1 || 1);
  const parsed = new Date(text as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** What the Postpone button sends as the new due text. For a live task it means "one day later", not a date to parse. */
export const POSTPONE_LABEL = "Postponed +1 day";

const asPriority = (v: string): Priority => (v === "high" || v === "low" ? v : "medium");

export function toTask(r: TaskRow, names: Map<string, string>, now = new Date()): Task {
  return {
    id: r.id, title: r.title, source: r.source, due: dueLabel(r.due_at, now), priority: asPriority(r.priority),
    assignee: (r.assignee_id && names.get(r.assignee_id)) || "Unassigned",
    status: r.status === "done" || r.status === "postponed" ? r.status : "open", href: r.related_ref || "/tasks",
  };
}

export function toApproval(r: ApprovalRow, now = new Date()): Approval {
  return {
    id: r.id, title: r.title, type: r.type as Approval["type"], generatedBy: (isAgent(r.generated_by) ? r.generated_by : "crm"),
    created: ago(r.created_at, now), status: r.status as Approval["status"], preview: r.preview, tone: "rose",
    meta: (r.meta ?? undefined) as Approval["meta"],
  };
}

export function toAudit(r: AuditRow, names: Map<string, string>): AuditEntry {
  return { id: String(r.id), approvalId: r.approval_id, action: r.action as AuditEntry["action"], actor: names.get(r.actor_id) ?? "A team member", at: r.at, note: r.note ?? undefined };
}

export function toActivity(r: ActivityRow, names: Map<string, string>, now = new Date()): Activity {
  const agent = isAgent(r.agent) ? r.agent : undefined;
  return { id: String(r.id), at: ago(r.created_at, now), actor: (r.actor_id && names.get(r.actor_id)) || (agent ? "Agent" : "A team member"), text: r.action, agent, ref: r.ref_id ?? undefined };
}

/* ---------- Customers, retailers and leads ---------- */

export interface CustomerRow { id: string; name: string; instagram: string | null; phone: string | null; email: string | null; city: string | null; interests: string[] | null; created_at: string }
export interface RetailerRow { id: string; business: string; location: string | null; category: string | null; contact: string | null; email: string | null; phone: string | null; instagram: string | null; website: string | null; qualification: string | null; created_at: string }
export interface LeadRow { id: string; retailer_id: string; stage: string; score: number | null; temperature: string | null; owner_id: string | null; last_activity_at: string }

const NOT_RECORDED = "Not recorded";
const STAGE_SET: readonly string[] = ["new", "qualified", "contacted", "interested", "negotiation", "won", "lost"];
export const asStage = (v: string | undefined): PipelineStage => (v && STAGE_SET.includes(v) ? (v as PipelineStage) : "new");

/** `purchases` is the number of this customer's orders. The database has no Amazon/Flipkart click columns, so those are 0
 *  and the customer page hides them for live organisations. */
export function toCustomer(r: CustomerRow, purchases: number): Customer {
  return {
    id: r.id, name: r.name, instagram: r.instagram ?? "", phone: r.phone ?? "", email: r.email ?? "", city: r.city ?? "",
    firstSeen: new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
    interests: r.interests ?? [], amazonClicks: 0, flipkartClicks: 0, purchases,
  };
}

/** The database has no maps column, so the link is a Google Maps search built from the name and place: nothing is stored. */
export const mapsSearchUrl = (business: string, location: string | null): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([business, location].filter(Boolean).join(" "))}`;

/** A retailer plus its lead (score, temperature, stage live on the lead row). With no lead it is a new, unscored retailer. */
export function toRetailer(r: RetailerRow, lead?: LeadRow, now = new Date()): Retailer {
  const score = lead?.score ?? 0;
  const stage = asStage(lead?.stage);
  const temperature: Temperature = lead?.temperature === "HOT" || lead?.temperature === "WARM" || lead?.temperature === "COLD" ? lead.temperature : temperatureFor(score);
  return {
    id: r.id, business: r.business, location: r.location ?? "", category: r.category ?? "", score, temperature,
    status: stage.charAt(0).toUpperCase() + stage.slice(1), lastActivity: ago(lead?.last_activity_at ?? r.created_at, now),
    contact: r.contact ?? NOT_RECORDED, email: r.email ?? NOT_RECORDED, phone: r.phone ?? NOT_RECORDED,
    instagram: r.instagram ?? NOT_RECORDED, website: r.website ?? NOT_RECORDED, mapsUrl: mapsSearchUrl(r.business, r.location),
    qualification: r.qualification ?? "", stage,
  };
}

export function toDeal(l: LeadRow, r: RetailerRow, names: Map<string, string>, now = new Date()): Deal {
  return {
    id: l.id, retailerId: l.retailer_id, business: r.business, location: r.location ?? "", stage: asStage(l.stage),
    score: l.score ?? 0, owner: (l.owner_id && names.get(l.owner_id)) || "Unassigned", updated: ago(l.last_activity_at, now),
  };
}

/* ---------- Products and content ---------- */

export interface ProductRow { id: string; sku: string; name: string; category: string | null; price: number | string | null; stock: number | null; status: string; channels: string[] | null; created_at: string }
export interface ContentRow {
  id: string; platform: string; title: string; topic: string | null; caption: string | null; hashtags: string[] | null; creative_brief: string | null;
  image_direction: string | null; scheduled_for: string | null; status: string; approval_id: string | null; created_at: string;
}

const PRODUCT_STATUS: readonly string[] = ["draft", "active", "low_stock", "archived"];

export function toProduct(r: ProductRow): Product {
  return {
    id: r.id, sku: r.sku, name: r.name, category: r.category ?? "", price: r.price === null ? null : Number(r.price), stock: r.stock,
    channels: r.channels ?? [], status: PRODUCT_STATUS.includes(r.status) ? (r.status as Product["status"]) : "draft",
  };
}

/** Only these three platforms have a social composer; the other platforms the table allows (Pinterest, Email, Amazon A+) are not shown as posts. */
export const SOCIAL_DB_PLATFORMS: readonly SocialPlatform[] = ["Instagram", "Facebook", "LinkedIn"];

/** The database status is only a fallback: when the post has an approval, its status follows that approval (see deriveStatus).
 *  The app never publishes; a row marked "published" counts as approved only if an approval for it says so (otherwise it is a draft). */
const SOCIAL_STATUS: Record<string, SocialStatus> = { draft: "draft", pending_approval: "pending_approval", approved: "approved", rejected: "rejected", published: "approved" };

export function toSocialPost(r: ContentRow): SocialPost {
  return {
    id: r.id, title: r.title, topic: r.topic ?? "", platform: r.platform as SocialPlatform, caption: r.caption ?? "", hashtags: r.hashtags ?? [],
    creativeBrief: r.creative_brief ?? "", imageDirection: r.image_direction ?? "",
    scheduledFor: r.scheduled_for ?? r.created_at.slice(0, 10), // an undated legacy row is placed on the day it was created
    approvalId: r.approval_id ?? undefined, isSample: false, tone: "rose",
    // a status is believed only with an approval behind it (and liveSocialPosts re-checks that approval); a stored status alone, such as one set by hand, is a draft
    seedStatus: r.approval_id ? (SOCIAL_STATUS[r.status] ?? "draft") : "draft",
  };
}

/* ---------- Orders ---------- */

export interface OrderRow { id: string; customer_id: string | null; retailer_id: string | null; channel: string; status: string; total: number | string; line_items: unknown; ordered_at: string }

/** The table's check constraints keep channel and status inside these lists; an unexpected value falls back rather than crashing a page. */
export function toOrder(r: OrderRow): Order {
  const items = Array.isArray(r.line_items) ? r.line_items.filter((i): i is Record<string, unknown> => !!i && typeof i === "object" && !Array.isArray(i)) : [];
  return {
    id: r.id, customerId: r.customer_id, retailerId: r.retailer_id, total: Number(r.total), lineItems: items, orderedAt: r.ordered_at,
    channel: (ORDER_CHANNELS as readonly string[]).includes(r.channel) ? (r.channel as Order["channel"]) : "other",
    status: (ORDER_STATUSES as readonly string[]).includes(r.status) ? (r.status as Order["status"]) : "new",
  };
}

/* ---------- Purchases and sales (the business rules agreed for orders) ---------- */

/** A customer's purchases are all of their orders except these. Statuses are the table's own: new, paid, shipped, delivered, cancelled, returned. */
export const NON_PURCHASE_STATUSES = ["cancelled", "returned"] as const;

/** Revenue counts delivered orders only. New, paid, shipped, cancelled and returned orders are excluded. */
export const REVENUE_STATUS = "delivered";

const WEEK_MS = 7 * 86_400_000;
const rupees = (cents: number) => `₹${Math.round(cents / 100).toLocaleString("en-IN")}`;

/** The Sales report for a live organisation, from delivered orders only. `rows` must already be delivered orders.
 *  Six rolling 7-day weeks ending now (Wk 6 is the latest), compared with the six weeks before. The table stores no delivery
 *  date, so an order is dated by `ordered_at`. Orders dated in the future are ignored. */
export function salesReport(rows: { total: number | string; ordered_at: string }[], now = new Date()): ReportSection {
  const weekCents = Array<number>(12).fill(0); // 0 = newest week, 11 = oldest of the previous period
  const weekCount = Array<number>(12).fill(0);
  for (const r of rows) {
    const age = now.getTime() - new Date(r.ordered_at).getTime();
    if (!(age >= 0)) continue;
    const i = Math.floor(age / WEEK_MS);
    if (i > 11) continue;
    weekCents[i] += Math.round(Number(r.total) * 100);
    weekCount[i] += 1;
  }
  const sum = (a: number[], from: number, to: number) => a.slice(from, to).reduce((x, y) => x + y, 0);
  const [rev, prevRev] = [sum(weekCents, 0, 6), sum(weekCents, 6, 12)];
  const [count, prevCount] = [sum(weekCount, 0, 6), sum(weekCount, 6, 12)];
  const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
  const aov = count ? Math.round(rev / count) : null;
  const prevAov = prevCount ? Math.round(prevRev / prevCount) : null;
  return {
    id: "sales", label: "Sales", seriesTitle: "Delivered revenue by week (₹ thousand)",
    note: "Only delivered orders count. New, paid, shipped, cancelled and returned orders are left out. Orders are dated by when they were placed, because no delivery date is stored. Compared with the six weeks before.",
    metrics: [
      { label: "Revenue (delivered)", value: rupees(rev), change: pct(rev, prevRev) },
      { label: "Delivered orders", value: count.toLocaleString("en-IN"), change: pct(count, prevCount) },
      { label: "Average order value", value: aov === null ? "—" : rupees(aov), change: aov !== null && prevAov !== null ? pct(aov, prevAov) : null },
    ],
    series: Array.from({ length: 6 }, (_, k) => ({ label: `Wk ${k + 1}`, value: Math.round(weekCents[5 - k] / 100) / 1000 })),
  };
}
