/** B2C Sales Agent server entry points (live organisations only): enquiries, the conversation history, recommendations, drafted replies, the
 *  approval hand-off and follow-ups. Everything runs through the signed-in user's own Supabase session (row level security + an explicit org filter).
 *  Nothing here sends a message to a customer: a reply is a draft, an approver decides on it in Approvals, and "sent_manually" is only a person's note
 *  that they sent it OUTSIDE this app. The enquiry tables come from an unapplied migration; until it is applied every function throws NotSetUpError. */
import { isLiveOrg } from "@/lib/auth/access";
import { readAiConfig } from "@/lib/ai/config";
import { buildReply } from "@/lib/b2c-live/ai";
import { analyseEnquiry, catalogueNotes, recommendProducts } from "@/lib/b2c-live/recommend";
import { replyViolations } from "@/lib/b2c-live/reply";
import { MAX_REPLY, cleanMessage, isUuid, phoneDigits, type FollowUpInput, type FollowUpPatch, type ListQuery } from "@/lib/b2c-live/validate";
import type { Approval } from "@/types";
import type {
  Enquiry, EnquiryDetail, EnquiryFollowUp, EnquiryInput, EnquiryMessage, EnquiryStatus, MessageStatus, NewCustomerInput, Page, ProductRecommendation, ReplyOutcome, EnquiryContext,
} from "@/types/enquiry";
import { aiRuntime } from "./content-ai";
import { ctx, fail, liveCreateCustomer, liveLog, liveProduct, liveProducts } from "./live";
import { toApproval, type ApprovalRow } from "./live-map";

/** The enquiry tables do not exist yet (the migration has not been applied). The API answers 503. */
export class NotSetUpError extends Error {
  constructor() { super("Customer enquiries are not set up yet. The database migration for enquiries has not been applied."); this.name = "NotSetUpError"; }
}

type Sb = Awaited<ReturnType<typeof ctx>>["supabase"];
type DbError = { code?: string; message: string };
const missingTable = (e: DbError) => e.code === "42P01" || e.code === "42883" || e.code === "PGRST205" || e.code === "PGRST202" || /relation .* does not exist|schema cache|Could not find the (table|function)/i.test(e.message);
/** Like fail(), but a missing enquiry table is reported as "not set up" rather than a generic database error. */
function check(error: DbError | null): void { if (error) { if (missingTable(error)) throw new NotSetUpError(); fail(error); } }
/** A rule of the database itself (the guard trigger raises P0001) is an answer, not a fault: the request was not allowed in the current state. */
const guarded = (e: DbError | null) => !!e && e.code === "P0001";
const GUARD_REFUSAL = "That change is not allowed in the reply's current state. Reload and try again.";
const uniqueViolation = (e: DbError | null) => !!e && e.code === "23505";

const ENQUIRY_COLS = "id, customer_id, product_id, source, status, subject, created_at, last_message_at";
const MESSAGE_COLS = "id, enquiry_id, direction, body, status, product_id, approval_id, generated_by, model, created_at";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

interface EnquiryRow { id: string; customer_id: string | null; product_id: string | null; source: Enquiry["source"]; status: EnquiryStatus; subject: string; created_at: string; last_message_at: string }
interface MessageRow { id: string; enquiry_id: string; direction: EnquiryMessage["direction"]; body: string; status: MessageStatus; product_id: string | null; approval_id: string | null; generated_by: EnquiryMessage["generatedBy"]; model: string | null; created_at: string }

const toEnquiry = (r: EnquiryRow): Enquiry => ({ id: r.id, customerId: r.customer_id, productId: r.product_id, source: r.source, status: r.status, subject: r.subject, createdAt: r.created_at, lastMessageAt: r.last_message_at });
const toMessage = (r: MessageRow): EnquiryMessage => ({ id: r.id, enquiryId: r.enquiry_id, direction: r.direction, body: r.body, status: r.status, productId: r.product_id, approvalId: r.approval_id, generatedBy: r.generated_by, model: r.model, createdAt: r.created_at });

export type B2cFailure = "not_live" | "not_found" | "customer_not_found" | "product_not_found" | "invalid_state" | "prohibited_claims" | "duplicate" | "assignee_not_member";
export type B2cResult<T> = ({ ok: true } & T) | { ok: false; reason: B2cFailure; error: string; detail?: string[]; existingId?: string };
const refuse = (reason: B2cFailure, error: string, detail?: string[], existingId?: string) => ({ ok: false as const, reason, error, ...(detail ? { detail } : {}), ...(existingId ? { existingId } : {}) });
const NOT_LIVE = refuse("not_live", "Enquiries are available to signed-in live organisations only.");

/** Append-only history for one enquiry (agent_activity with ref_type "enquiry"). Best effort, like every activity line. The text never carries customer data. */
async function note(supabase: Sb, orgId: string, userId: string, enquiryId: string, action: string): Promise<void> {
  try { await supabase.from("agent_activity").insert({ org_id: orgId, agent: "b2c", action: action.slice(0, 500), ref_type: "enquiry", ref_id: enquiryId, actor_id: userId }); } catch { /* history is best effort */ }
}

async function loadEnquiry(supabase: Sb, orgId: string, id: string): Promise<EnquiryRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase.from("enquiries").select(ENQUIRY_COLS).eq("org_id", orgId).eq("id", id).maybeSingle();
  check(error);
  return (data as EnquiryRow | null) ?? null;
}

async function loadMessages(supabase: Sb, orgId: string, enquiryId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase.from("enquiry_messages").select(MESSAGE_COLS).eq("org_id", orgId).eq("enquiry_id", enquiryId).order("created_at").order("id");
  check(error);
  return (data ?? []) as MessageRow[];
}

/* ---------- Enquiries ---------- */

/** The same message from the same customer through the same channel inside this window is treated as an accidental double submit
 *  (decided inside the create_b2c_enquiry function, under a lock, so two simultaneous requests cannot both create one). */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

/** An existing customer of THIS organisation with exactly this email (stored lower-case), this Instagram handle (lower-case) or this phone number (compared as
 *  digits). Every comparison is exact: no value is ever used as a pattern, so "%" or "*" can never match somebody else's record. Never creates anything. */
async function findCustomer(supabase: Sb, orgId: string, c: NewCustomerInput): Promise<string | null> {
  for (const [col, val] of [["email", c.email], ["instagram", c.instagram]] as const) {
    if (!val) continue;
    const { data, error } = await supabase.from("customers").select("id").eq("org_id", orgId).eq(col, val).order("created_at").limit(1);
    if (error) fail(error);
    const hit = ((data ?? []) as { id: string }[])[0];
    if (hit) return hit.id;
  }
  if (c.phone) {
    // Stored phones may be formatted ("98765 43210"), so narrow by the last four digits (digits only, so no wildcard can come from the caller) and compare the full digits exactly.
    const want = phoneDigits(c.phone);
    const { data, error } = await supabase.from("customers").select("id, phone").eq("org_id", orgId).like("phone", `%${want.slice(-4)}%`).order("created_at").limit(100);
    if (error) fail(error);
    const hit = ((data ?? []) as { id: string; phone: string | null }[]).find((r) => r.phone && phoneDigits(r.phone) === want);
    if (hit) return hit.id;
  }
  return null;
}

export async function createEnquiry(input: EnquiryInput): Promise<B2cResult<{ enquiry: EnquiryDetail; customer: { id: string; created: boolean } | null; warning?: string }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  let productName: string | null = null;
  let customerId = input.customerId;
  if (input.customerId) {
    const { data, error } = await supabase.from("customers").select("id").eq("org_id", orgId).eq("id", input.customerId).maybeSingle();
    if (error) fail(error);
    if (!data) return refuse("customer_not_found", "Customer not found.");
  } else if (input.customer) {
    customerId = await findCustomer(supabase, orgId, input.customer);
  }
  if (input.productId) {
    const p = await liveProduct(input.productId);
    if (!p) return refuse("product_not_found", "Product not found.");
    productName = p.name;
  }
  const subject = clip(input.message.split("\n")[0] ?? "", 120) || "Enquiry";
  // One transaction in the database: the enquiry and its first message exist together or not at all, and a repeat of the same message is answered with the existing enquiry.
  const made = await supabase.rpc("create_b2c_enquiry", { p_org_id: orgId, p_source: input.source, p_customer_id: customerId, p_product_id: input.productId, p_subject: subject, p_message: input.message });
  check(made.error);
  const res = made.data as { id: string; duplicate: boolean } | null;
  if (!res) fail({ message: "Database request failed" });
  if (res.duplicate) return refuse("duplicate", "This enquiry was already logged a moment ago. Open the existing conversation instead.", undefined, res.id);
  // A new customer is created only AFTER the enquiry exists, so a failed enquiry never leaves an orphan customer behind. It goes through the CRM's own path
  // (same validation, same activity line). If that fails the enquiry stands without a customer and the caller is told.
  let customerCreated = false;
  let warning: string | undefined;
  if (!customerId && input.customer) {
    try {
      const c = await liveCreateCustomer({ name: input.customer.name, email: input.customer.email, phone: input.customer.phone, instagram: input.customer.instagram, city: input.customer.city, interests: [] });
      const link = await supabase.from("enquiries").update({ customer_id: c.id }).eq("org_id", orgId).eq("id", res.id);
      if (link.error) warning = "The enquiry was saved and the customer was added to the CRM, but they could not be linked to it. Link them by hand.";
      else { customerId = c.id; customerCreated = true; }
    } catch { warning = "The enquiry was saved, but the customer could not be added to the CRM. Add them from the Customers page."; }
  }
  const row = await loadEnquiry(supabase, orgId, res.id);
  if (!row) fail({ message: "Database request failed" });
  const messages = await loadMessages(supabase, orgId, res.id);
  const what = `Logged a ${input.source.replace("_", " ")} enquiry${productName ? ` about ${productName}` : ""}`;
  await note(supabase, orgId, userId, res.id, what);
  await liveLog({ agent: "b2c", action: what });
  return { ok: true, enquiry: { ...toEnquiry(row), messages: messages.map(toMessage), followUps: [], history: [] }, customer: customerId ? { id: customerId, created: customerCreated } : null, ...(warning ? { warning } : {}) };
}

/** Newest activity first. Fetches one extra row to know whether another page exists. */
export async function listEnquiries(q: Pick<ListQuery, "limit" | "offset"> & Partial<Pick<ListQuery, "status" | "customerId">> = { limit: 50, offset: 0 }): Promise<{ items: Enquiry[]; page: Page }> {
  const { supabase, orgId } = await ctx();
  let sel = supabase.from("enquiries").select(ENQUIRY_COLS).eq("org_id", orgId);
  if (q.status) sel = sel.eq("status", q.status);
  if (q.customerId) sel = sel.eq("customer_id", q.customerId);
  const { data, error } = await sel.order("last_message_at", { ascending: false }).order("id").range(q.offset, q.offset + q.limit);
  check(error);
  const rows = (data ?? []) as EnquiryRow[];
  return { items: rows.slice(0, q.limit).map(toEnquiry), page: { limit: q.limit, offset: q.offset, hasMore: rows.length > q.limit } };
}

/** The conversation, oldest first, a page at a time. null when the enquiry is not this organisation's. */
export async function listMessages(enquiryId: string, q: Pick<ListQuery, "limit" | "offset">): Promise<{ items: EnquiryMessage[]; page: Page } | null> {
  const { supabase, orgId } = await ctx();
  if (!(await loadEnquiry(supabase, orgId, enquiryId))) return null;
  const { data, error } = await supabase.from("enquiry_messages").select(MESSAGE_COLS).eq("org_id", orgId).eq("enquiry_id", enquiryId).order("created_at").order("id").range(q.offset, q.offset + q.limit);
  check(error);
  const rows = (data ?? []) as MessageRow[];
  const shown = rows.slice(0, q.limit);
  return { items: shown.map(toMessage), page: { limit: q.limit, offset: q.offset, hasMore: rows.length > q.limit } };
}

const followUpRef = (id: string) => `/b2c?enquiry=${id}`;

export async function getEnquiry(id: string): Promise<EnquiryDetail | null> {
  const { supabase, orgId } = await ctx();
  const row = await loadEnquiry(supabase, orgId, id);
  if (!row) return null;
  const messages = await loadMessages(supabase, orgId, id);
  const t = await supabase.from("tasks").select("id, title, due_at, status, priority, assignee_id").eq("org_id", orgId).eq("related_ref", followUpRef(id)).order("created_at");
  if (t.error) fail(t.error);
  const h = await supabase.from("agent_activity").select("action, created_at").eq("org_id", orgId).eq("ref_type", "enquiry").eq("ref_id", id).order("created_at");
  if (h.error) fail(h.error);
  const followUps: EnquiryFollowUp[] = ((t.data ?? []) as { id: string; title: string; due_at: string | null; status: EnquiryFollowUp["status"]; priority: EnquiryFollowUp["priority"]; assignee_id: string | null }[])
    .map((r) => ({ id: r.id, title: r.title, dueAt: r.due_at, status: r.status, priority: r.priority, assigneeId: r.assignee_id }));
  return {
    ...toEnquiry(row), messages: messages.map(toMessage), followUps,
    history: ((h.data ?? []) as { action: string; created_at: string }[]).map((r) => ({ at: r.created_at, action: r.action })),
  };
}

/* ---------- Recommendations and replies ---------- */

const inboundText = (messages: MessageRow[]) => messages.filter((m) => m.direction === "inbound").map((m) => m.body).join("\n");

/** Deterministic matches from the live catalogue. No AI, nothing saved. */
export async function recommendForEnquiry(id: string, pinnedProductId?: string | null): Promise<B2cResult<{ context: EnquiryContext; recommendations: ProductRecommendation[]; catalogueNotes: string[] }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId } = await ctx();
  const row = await loadEnquiry(supabase, orgId, id);
  if (!row) return refuse("not_found", "Enquiry not found.");
  const text = inboundText(await loadMessages(supabase, orgId, id));
  const products = await liveProducts();
  const pinned = pinnedProductId ?? row.product_id;
  if (pinnedProductId && !products.some((p) => p.id === pinnedProductId && p.status !== "archived")) return refuse("product_not_found", "Product not found.");
  const context = analyseEnquiry(text).context;
  const recommendations = recommendProducts(text, products, { pinnedProductId: pinned });
  return { ok: true, context, recommendations, catalogueNotes: catalogueNotes(recommendations, context.scenario) };
}

/** Drafts (or re-drafts) the reply to an enquiry. AI is used only when every gate in aiRuntime() passes; otherwise a template. An enquiry keeps at most one
 *  open draft: a second request replaces its wording instead of adding another, and a draft that is already awaiting approval is never touched. */
export async function draftReply(id: string, opts: { productId?: string | null } = {}): Promise<B2cResult<{ message: EnquiryMessage; outcome: ReplyOutcome; regenerated: boolean; catalogueNotes: string[] }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  const row = await loadEnquiry(supabase, orgId, id);
  if (!row) return refuse("not_found", "Enquiry not found.");
  if (row.status === "closed") return refuse("invalid_state", "This enquiry is closed.");
  const messages = await loadMessages(supabase, orgId, id);
  const outbound = messages.filter((m) => m.direction === "outbound");
  if (outbound.some((m) => m.status === "pending_approval")) return refuse("invalid_state", "A reply to this enquiry is already waiting in Approvals.");
  const open = outbound.filter((m) => m.status === "draft" || m.status === "rejected").at(-1);

  const products = await liveProducts();
  if (opts.productId && !products.some((p) => p.id === opts.productId && p.status !== "archived")) return refuse("product_not_found", "Product not found.");
  const context = analyseEnquiry(inboundText(messages)).context;
  const recs = recommendProducts(inboundText(messages), products, { pinnedProductId: opts.productId ?? row.product_id });
  const runtime = readAiConfig().enabled ? await aiRuntime() : null;
  const outcome = await buildReply(context, recs, runtime);
  const productId = recs[0]?.productId ?? null;
  const fields = { body: outcome.body, status: "draft", generated_by: outcome.generator === "ai" ? "ai" : "template", model: outcome.model ?? null, product_id: productId, approval_id: null };

  let saved: MessageRow;
  if (open) {
    const up = await supabase.from("enquiry_messages").update(fields).eq("org_id", orgId).eq("id", open.id).in("status", ["draft", "rejected"]).select(MESSAGE_COLS);
    if (guarded(up.error)) return refuse("invalid_state", GUARD_REFUSAL);
    check(up.error);
    const first = ((up.data ?? []) as MessageRow[])[0];
    if (!first) return refuse("invalid_state", "The draft changed while it was being regenerated. Reload and try again.");
    saved = first;
  } else {
    const ins = await supabase.from("enquiry_messages").insert({ org_id: orgId, enquiry_id: id, direction: "outbound", ...fields }).select(MESSAGE_COLS).single();
    // the partial unique index allows one draft or pending reply per enquiry: a second simultaneous request loses here instead of adding another draft
    if (uniqueViolation(ins.error)) return refuse("invalid_state", "A draft for this enquiry was created at the same moment. Reload to see it.");
    check(ins.error);
    saved = ins.data as MessageRow;
  }
  const how = outcome.generator === "ai" ? `AI draft (${outcome.model}, ${outcome.promptVersion})` : "template draft";
  const product = recs[0] ? ` using ${recs[0].name}` : "";
  await note(supabase, orgId, userId, id, `${open ? "Regenerated" : "Created"} a reply ${how}${product}; not sent`);
  await liveLog({ agent: "b2c", action: `${open ? "Regenerated" : "Drafted"} a reply to an enquiry (${how})${product}; not sent` });
  return { ok: true, message: toMessage(saved), outcome, regenerated: !!open, catalogueNotes: catalogueNotes(recs, context.scenario) };
}

/** A person's edit of a draft (or of a rejected reply, which returns it to draft). The claim guard runs on the new text. A reply that is waiting in Approvals,
 *  approved or sent cannot be edited (the database refuses it too). */
export async function editDraft(enquiryId: string, messageId: string, bodyRaw: unknown): Promise<B2cResult<{ message: EnquiryMessage }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const body = cleanMessage(bodyRaw, MAX_REPLY);
  if (!body) return refuse("invalid_state", `Enter the reply text (1 to ${MAX_REPLY} characters, plain text).`);
  const violations = replyViolations(body);
  if (violations.length) return refuse("prohibited_claims", "The reply contains wording that needs client-approved claims.", violations.map((v) => `${v.label}: "${v.match}"`));
  const { supabase, orgId, userId } = await ctx();
  const found = await findOutbound(supabase, orgId, enquiryId, messageId);
  if (!found) return refuse("not_found", "Draft not found.");
  if (found.status !== "draft" && found.status !== "rejected") return refuse("invalid_state", "Only a draft or a rejected reply can be edited.");
  const up = await supabase.from("enquiry_messages").update({ body, status: "draft", generated_by: "human", approval_id: null }).eq("org_id", orgId).eq("id", messageId).in("status", ["draft", "rejected"]).select(MESSAGE_COLS);
  if (guarded(up.error)) return refuse("invalid_state", GUARD_REFUSAL);
  check(up.error);
  const row = ((up.data ?? []) as MessageRow[])[0];
  if (!row) return refuse("invalid_state", "The reply changed while it was being edited (it may have just been sent for approval). Reload and try again.");
  await note(supabase, orgId, userId, enquiryId, "Edited the drafted reply");
  return { ok: true, message: toMessage(row) };
}

async function findOutbound(supabase: Sb, orgId: string, enquiryId: string, messageId: string): Promise<MessageRow | null> {
  if (!isUuid(enquiryId) || !isUuid(messageId)) return null;
  const { data, error } = await supabase.from("enquiry_messages").select(MESSAGE_COLS).eq("org_id", orgId).eq("enquiry_id", enquiryId).eq("id", messageId).eq("direction", "outbound").maybeSingle();
  check(error);
  return (data as MessageRow | null) ?? null;
}

/** Queues the draft in the existing Approval Centre. Nothing is sent. Every AI or template reply goes through here: there is no other route to "approved".
 *  One database function does it all in a single transaction: it locks the message, refuses if the text is no longer what the caller reviewed, builds the
 *  approval FROM the locked text, and links it. Repeating a submit that already succeeded returns the same approval and creates nothing. */
export async function submitDraft(enquiryId: string, messageId: string): Promise<B2cResult<{ approval: Approval; message: EnquiryMessage; alreadySubmitted: boolean }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  const row = await loadEnquiry(supabase, orgId, enquiryId);
  const msg = row ? await findOutbound(supabase, orgId, enquiryId, messageId) : null;
  if (!row || !msg) return refuse("not_found", "Draft not found.");
  if (msg.status !== "draft" && msg.status !== "pending_approval") return refuse("invalid_state", "Only a draft can be sent for approval. Edit a rejected reply first.");
  const violations = replyViolations(msg.body);
  if (violations.length) return refuse("prohibited_claims", "The reply contains wording that needs client-approved claims.", violations.map((v) => `${v.label}: "${v.match}"`));
  const productName = msg.product_id ? (await liveProduct(msg.product_id))?.name ?? null : null;
  const label = productName ?? `${row.source.replace("_", " ")} enquiry`;
  const made = await supabase.rpc("submit_b2c_reply", { p_org_id: orgId, p_enquiry_id: enquiryId, p_message_id: messageId, p_expected_body: msg.body, p_title: `Reply · ${label}`, p_subject: label });
  if (made.error) {
    if (made.error.code === "P0002") return refuse("not_found", "Draft not found.");
    if (made.error.code === "P0001") return refuse("invalid_state", "This reply changed (it was edited or already handled) since you opened it. Reload and review it again.");
    check(made.error);
  }
  if (!made.data) fail({ message: "Database request failed" });
  const approval = toApproval(made.data as ApprovalRow);
  const fresh = await findOutbound(supabase, orgId, enquiryId, messageId);
  if (!fresh) return refuse("not_found", "Draft not found.");
  const alreadySubmitted = msg.status === "pending_approval";
  if (!alreadySubmitted) {
    await note(supabase, orgId, userId, enquiryId, "Sent the drafted reply for approval (not sent to the customer)");
    await liveLog({ agent: "b2c", action: `Sent a drafted reply (${label}) for approval (not sent to the customer)` });
  }
  return { ok: true, approval, message: toMessage(fresh), alreadySubmitted };
}

/** Records that a person sent an APPROVED reply outside this app. The reply must carry an approval of this organisation, of the reply type, that says approved:
 *  a stored "approved" with no such approval is refused (and the database refuses it independently). The app delivers nothing. */
export async function markSentManually(enquiryId: string, messageId: string): Promise<B2cResult<{ message: EnquiryMessage }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  const msg = await findOutbound(supabase, orgId, enquiryId, messageId);
  if (!msg) return refuse("not_found", "Reply not found.");
  if (msg.status === "sent_manually") return refuse("duplicate", "This reply is already recorded as sent.");
  const NOT_APPROVED = "Only an approved reply can be recorded as sent.";
  if (msg.status !== "approved" || !msg.approval_id) return refuse("invalid_state", NOT_APPROVED);
  const a = await supabase.from("approvals").select("id, status, type").eq("org_id", orgId).eq("id", msg.approval_id).maybeSingle();
  if (a.error) fail(a.error);
  const approval = a.data as { id: string; status: Approval["status"]; type: string } | null;
  if (!approval || approval.type !== "B2C Reply" || (approval.status !== "approved" && approval.status !== "executed")) return refuse("invalid_state", NOT_APPROVED);
  const up = await supabase.from("enquiry_messages").update({ status: "sent_manually" }).eq("org_id", orgId).eq("id", messageId).eq("status", "approved").eq("approval_id", msg.approval_id).select(MESSAGE_COLS);
  if (guarded(up.error)) return refuse("invalid_state", NOT_APPROVED);
  check(up.error);
  const row = ((up.data ?? []) as MessageRow[])[0];
  if (!row) return refuse("duplicate", "This reply is already recorded as sent.");
  await note(supabase, orgId, userId, enquiryId, "Recorded that the approved reply was sent by a person outside this app");
  return { ok: true, message: toMessage(row) };
}

/* ---------- Follow-ups (rows in the existing tasks table, linked by related_ref) ---------- */

/** One open follow-up per enquiry at a time. The assignee must belong to this organisation. */
export async function createFollowUp(enquiryId: string, input: FollowUpInput): Promise<B2cResult<{ followUp: EnquiryFollowUp }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  const row = await loadEnquiry(supabase, orgId, enquiryId);
  if (!row) return refuse("not_found", "Enquiry not found.");
  if (input.assigneeId) {
    const { data, error } = await supabase.from("memberships").select("user_id").eq("org_id", orgId).eq("user_id", input.assigneeId).maybeSingle();
    if (error) fail(error);
    if (!data) return refuse("assignee_not_member", "That person is not a member of this organisation.");
  }
  const ref = followUpRef(enquiryId);
  const dup = await supabase.from("tasks").select("id").eq("org_id", orgId).eq("related_ref", ref).eq("status", "open").limit(1);
  if (dup.error) fail(dup.error);
  if (((dup.data ?? []) as unknown[]).length) return refuse("duplicate", "This enquiry already has an open follow-up.");
  const made = await supabase.from("tasks").insert({
    org_id: orgId, title: clip(`Follow up: ${input.reason}`, 200), source: "B2C enquiry", priority: input.priority, due_at: `${input.dueDate}T12:00:00.000Z`,
    assignee_id: input.assigneeId, related_ref: ref,
  }).select("id, title, due_at, status, priority, assignee_id").single();
  if (made.error || !made.data) fail(made.error ?? { message: "Database request failed" });
  const r = made.data as { id: string; title: string; due_at: string | null; status: EnquiryFollowUp["status"]; priority: EnquiryFollowUp["priority"]; assignee_id: string | null };
  await note(supabase, orgId, userId, enquiryId, `Created a follow-up due ${input.dueDate}`);
  await liveLog({ agent: "b2c", action: `Created a follow-up task for an enquiry (due ${input.dueDate})` });
  return { ok: true, followUp: { id: r.id, title: r.title, dueAt: r.due_at, status: r.status, priority: r.priority, assigneeId: r.assignee_id } };
}

/* ---------- Conversation status and follow-up updates ---------- */

/** The status an enquiry shows follows its latest reply (the database keeps it that way); a person may only close it, or reopen a closed one. */
function statusFromMessages(messages: MessageRow[]): EnquiryStatus {
  const last = messages.filter((m) => m.direction === "outbound").at(-1);
  if (!last) return "new";
  switch (last.status) {
    case "sent_manually": return "replied";
    case "approved": return "approved";
    case "pending_approval": return "awaiting_approval";
    default: return "draft_ready";
  }
}

/** Closes an enquiry, or reopens a closed one to the status its latest reply implies. A reply waiting in Approvals blocks closing. */
export async function setEnquiryClosed(id: string, closed: boolean): Promise<B2cResult<{ enquiry: Enquiry }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  const row = await loadEnquiry(supabase, orgId, id);
  if (!row) return refuse("not_found", "Enquiry not found.");
  const messages = await loadMessages(supabase, orgId, id);
  if (closed) {
    if (row.status === "closed") return refuse("duplicate", "This enquiry is already closed.");
    if (messages.some((m) => m.direction === "outbound" && m.status === "pending_approval")) return refuse("invalid_state", "A reply to this enquiry is waiting in Approvals. Decide it before closing.");
  } else if (row.status !== "closed") return refuse("invalid_state", "This enquiry is not closed.");
  const next: EnquiryStatus = closed ? "closed" : statusFromMessages(messages);
  const up = await supabase.from("enquiries").update({ status: next }).eq("org_id", orgId).eq("id", id).eq("status", row.status).select(ENQUIRY_COLS);
  if (guarded(up.error)) return refuse("invalid_state", "The enquiry changed while it was being updated (a reply may have just been sent for approval). Reload and try again.");
  check(up.error);
  const updated = ((up.data ?? []) as EnquiryRow[])[0];
  if (!updated) return refuse("invalid_state", "The enquiry changed while it was being updated. Reload and try again.");
  await note(supabase, orgId, userId, id, closed ? "Closed the enquiry" : "Reopened the enquiry");
  return { ok: true, enquiry: toEnquiry(updated) };
}

const TASK_COLS = "id, title, due_at, status, priority, assignee_id";
type TaskRow = { id: string; title: string; due_at: string | null; status: EnquiryFollowUp["status"]; priority: EnquiryFollowUp["priority"]; assignee_id: string | null };
const toFollowUp = (r: TaskRow): EnquiryFollowUp => ({ id: r.id, title: r.title, dueAt: r.due_at, status: r.status, priority: r.priority, assigneeId: r.assignee_id });

/** Changes status (open / done / postponed), due date, priority or reason of a follow-up that belongs to THIS enquiry. At most one follow-up may be open. */
export async function updateFollowUp(enquiryId: string, followUpId: string, patch: FollowUpPatch): Promise<B2cResult<{ followUp: EnquiryFollowUp }>> {
  if (!(await isLiveOrg())) return NOT_LIVE;
  const { supabase, orgId, userId } = await ctx();
  if (!(await loadEnquiry(supabase, orgId, enquiryId)) || !isUuid(followUpId)) return refuse("not_found", "Follow-up not found.");
  const ref = followUpRef(enquiryId);
  const cur = await supabase.from("tasks").select(TASK_COLS).eq("org_id", orgId).eq("id", followUpId).eq("related_ref", ref).maybeSingle();
  if (cur.error) fail(cur.error);
  const task = cur.data as TaskRow | null;
  if (!task) return refuse("not_found", "Follow-up not found.");
  if (patch.status && patch.status === task.status && Object.keys(patch).length === 1) return refuse("duplicate", `This follow-up is already ${task.status}.`);
  if (patch.status === "open" && task.status !== "open") {
    const other = await supabase.from("tasks").select("id").eq("org_id", orgId).eq("related_ref", ref).eq("status", "open").limit(1);
    if (other.error) fail(other.error);
    if (((other.data ?? []) as unknown[]).length) return refuse("duplicate", "This enquiry already has an open follow-up.");
  }
  const change: Record<string, unknown> = {};
  if (patch.status) change.status = patch.status;
  if (patch.priority) change.priority = patch.priority;
  if (patch.dueDate) change.due_at = `${patch.dueDate}T12:00:00.000Z`;
  if (patch.reason) change.title = clip(`Follow up: ${patch.reason}`, 200);
  const up = await supabase.from("tasks").update(change).eq("org_id", orgId).eq("id", followUpId).eq("related_ref", ref).eq("status", task.status).select(TASK_COLS);
  if (up.error) fail(up.error);
  const row = ((up.data ?? []) as TaskRow[])[0];
  if (!row) return refuse("invalid_state", "The follow-up changed while it was being updated. Reload and try again.");
  const what = patch.status === "done" ? "Completed the follow-up" : patch.status ? `Marked the follow-up ${patch.status}` : "Updated the follow-up";
  await note(supabase, orgId, userId, enquiryId, what + (patch.dueDate ? ` (now due ${patch.dueDate})` : ""));
  await liveLog({ agent: "b2c", action: `${what} for an enquiry` });
  return { ok: true, followUp: toFollowUp(row) };
}
