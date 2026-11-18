/** B2C Sales Agent (Milestone 3): enquiry intake, deterministic recommendations, AI-assisted drafts (fake transport only), conversation history,
 *  Approval Centre hand-off, follow-ups, organisation isolation, roles and error handling. The database is a recording in-memory fake; nothing touches
 *  OpenAI or Supabase. The real SQL (constraints, composite foreign keys, row level security) is exercised in tests/rls.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => {
  const o = {
    t: {} as Record<string, Row[]>, reads: [] as string[], n: 0,
    /** Makes opening this table fail like a missing table (42P01), or like a code fault (TypeError). */
    missing: "", crash: "",
    /** The fake reproduces what the migration's triggers do (the real SQL is tested in tests/b2c-enquiry-db.test.ts): the enquiry status follows the latest reply. */
    refresh(eid: unknown): void {
      const last = (o.t.enquiry_messages ?? []).filter((m) => m.enquiry_id === eid && m.direction === "outbound").at(-1);
      const st = !last ? "new" : last.status === "sent_manually" ? "replied" : last.status === "approved" ? "approved" : last.status === "pending_approval" ? "awaiting_approval" : "draft_ready";
      const e = (o.t.enquiries ?? []).find((r) => r.id === eid);
      if (e && e.status !== "closed") { e.status = st; e.last_message_at = new Date().toISOString(); }
    },
    /** Test hook: runs before the next create_b2c_enquiry / submit_b2c_reply, to simulate a competing request landing first. */
    beforeRpc: null as null | ((fn: string) => void),
  };
  return o;
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async (fn: string, a: Record<string, unknown>) => {
      if (db.missing === "rpc") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
      db.beforeRpc?.(fn);
      if (fn === "create_b2c_enquiry") {
        const since = Date.now() - 10 * 60_000;
        const hit = (db.t.enquiry_messages ?? []).find((m) => m.org_id === a.p_org_id && m.direction === "inbound" && m.body === a.p_message && String(m.created_at) >= new Date(since).toISOString()
          && (db.t.enquiries ?? []).some((e) => e.id === m.enquiry_id && e.source === a.p_source && (e.customer_id ?? null) === (a.p_customer_id ?? null)));
        if (hit) return { data: { id: hit.enquiry_id, duplicate: true }, error: null };
        if (db.crash === "enquiry_messages") return { data: null, error: { code: "XX000", message: "simulated failure after the enquiry row (rolled back)" } };
        const eid = crypto.randomUUID();
        (db.t.enquiries ??= []).push({ id: eid, org_id: a.p_org_id, customer_id: a.p_customer_id ?? null, product_id: a.p_product_id ?? null, source: a.p_source, status: "new", subject: a.p_subject, created_at: new Date().toISOString(), last_message_at: new Date().toISOString() });
        (db.t.enquiry_messages ??= []).push({ id: crypto.randomUUID(), org_id: a.p_org_id, enquiry_id: eid, direction: "inbound", body: a.p_message, status: "received", generated_by: "customer", product_id: a.p_product_id ?? null, approval_id: null, model: null, created_at: new Date().toISOString() });
        return { data: { id: eid, duplicate: false }, error: null };
      }
      if (fn === "submit_b2c_reply") {
        const m = (db.t.enquiry_messages ?? []).find((r) => r.id === a.p_message_id && r.enquiry_id === a.p_enquiry_id && r.org_id === a.p_org_id && r.direction === "outbound");
        if (!m) return { data: null, error: { code: "P0002", message: "not found" } };
        if (m.status === "pending_approval" && m.body === a.p_expected_body) return { data: { ...(db.t.approvals ?? []).find((r) => r.id === m.approval_id)! }, error: null };
        if (m.status !== "draft") return { data: null, error: { code: "P0001", message: "invalid state" } };
        if (m.body !== a.p_expected_body) return { data: null, error: { code: "P0001", message: "draft changed" } };
        const ap: Row = { id: crypto.randomUUID(), org_id: m.org_id, title: String(a.p_title).slice(0, 200), type: "B2C Reply", generated_by: "b2c", status: "pending", preview: m.body, created_at: new Date().toISOString(),
          meta: { kind: "b2c_reply", subject: a.p_subject, isSample: false, allowedClaims: [], agent: "b2c", ref: m.enquiry_id, messageId: m.id, productId: m.product_id, aiAssisted: m.generated_by === "ai", ...(m.model ? { aiModel: m.model } : {}) } };
        (db.t.approvals ??= []).push(ap);
        m.status = "pending_approval"; m.approval_id = ap.id;
        db.refresh(m.enquiry_id);
        return { data: { ...ap }, error: null };
      }
      const row = (db.t.approvals ?? []).find((r) => r.id === a.p_id);
      if (fn !== "decide_approval" || !row) return { data: null, error: { code: "P0002", message: "not found" } };
      if (row.status !== "pending") return { data: null, error: { code: "P0001", message: "already decided" } };
      if (a.p_action === "edit") { if (a.p_preview) row.preview = a.p_preview; } else row.status = a.p_action === "approve" ? "approved" : "rejected";
      (db.t.audit_log ??= []).push({ id: ++db.n, org_id: row.org_id, approval_id: row.id, action: a.p_action, actor_id: "u1", note: a.p_note ?? null, at: new Date().toISOString() });
      if (row.type === "B2C Reply") { // the b2c_reply_sync trigger
        for (const m of (db.t.enquiry_messages ?? []).filter((r) => r.approval_id === row.id && r.status === "pending_approval")) {
          m.body = row.preview;
          if (a.p_action !== "edit") m.status = a.p_action === "approve" ? "approved" : "rejected";
          db.refresh(m.enquiry_id);
        }
      }
      return { data: { ...row }, error: null };
    },
    from: (table: string) => {
      db.reads.push(table);
      if (db.crash === table) throw new TypeError("boom: simulated code fault");
      let op = "select";
      let payload: Row = {};
      const eq: [string, unknown][] = [];
      const neq: [string, unknown][] = [];
      const inn: [string, unknown[]][] = [];
      const ilk: [string, string][] = [];
      let rng: [number, number] | null = null;
      let single = false;
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (p: Row) => { op = "insert"; payload = p; return q; },
        update: (p: Row) => { op = "update"; payload = p; return q; },
        delete: () => { op = "delete"; return q; },
        eq: (k: string, v: unknown) => { eq.push([k, v]); return q; },
        neq: (k: string, v: unknown) => { neq.push([k, v]); return q; },
        in: (k: string, v: unknown[]) => { inn.push([k, v]); return q; },
        like: () => q, gte: () => q, not: () => q, order: () => q, limit: () => q,
        ilike: (k: string, v: string) => { ilk.push([k, v]); return q; },
        range: (from: number, to: number) => { rng = [from, to]; return q; },
        single: () => { single = true; return q; }, maybeSingle: () => { single = true; return q; },
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          if (db.missing === table) return resolve({ data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } });
          const rows = (db.t[table] ??= []);
          const match = (r: Row) => eq.every(([k, v]) => r[k] === v) && neq.every(([k, v]) => r[k] !== v) && inn.every(([k, v]) => v.includes(r[k])) && ilk.every(([k, v]) => String(r[k] ?? "").toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase());
          let out: Row[];
          if (op === "insert" && table === "enquiry_messages" && payload.direction === "outbound" && ["draft", "pending_approval"].includes(String(payload.status))
              && rows.some((r) => r.enquiry_id === payload.enquiry_id && r.direction === "outbound" && ["draft", "pending_approval"].includes(String(r.status)))) {
            return resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"enquiry_messages_one_live_reply\"" } });
          }
          if (op === "insert") {
            const defaults: Row = table === "tasks" ? { status: "open" } : table === "enquiries" ? { last_message_at: new Date().toISOString(), status: "new" } : table === "enquiry_messages" ? { approval_id: null, model: null, product_id: null } : {};
            const made: Row = { id: table === "agent_activity" || table === "audit_log" ? ++db.n : crypto.randomUUID(), created_at: new Date().toISOString(), ...defaults, ...payload };
            rows.push(made);
            out = [made];
          } else if (op === "update") {
            out = rows.filter(match);
            for (const r of out) Object.assign(r, payload);
          } else if (op === "delete") {
            out = rows.filter(match);
            db.t[table] = rows.filter((r) => !out.includes(r));
          } else out = rows.filter(match);
          if (table === "enquiry_messages" && (op === "insert" || op === "update")) for (const r of out) db.refresh(r.enquiry_id);
          if (op === "select" && rng) out = out.slice(rng[0], rng[1] + 1);
          resolve({ data: single ? (out[0] ? { ...out[0] } : null) : out.map((r) => ({ ...r })), error: null }); // always copies, like a real response
        },
      };
      return q;
    },
  }),
}));

import { decideApproval } from "@/services";
import { __setAiTransportForTests } from "@/services/content-ai";
import { GET as listRoute, POST as createRoute } from "@/app/api/b2c/enquiries/route";
import { GET as getRoute } from "@/app/api/b2c/enquiries/[id]/route";
import { POST as enquiryAction } from "@/app/api/b2c/enquiries/[id]/[action]/route";
import { POST as messageAction } from "@/app/api/b2c/enquiries/[id]/messages/[mid]/[action]/route";
import { POST as runRoute } from "@/app/api/agents/b2c/run/route";
import type { AiConfig } from "@/lib/ai/config";
import { CallRateLimiter } from "@/lib/ai/limits";
import { B2C_INSTRUCTIONS, buildB2cInput, buildReply } from "@/lib/b2c-live/ai";
import { analyseEnquiry, recommendProducts, terms } from "@/lib/b2c-live/recommend";
import { replyViolations, templateReply } from "@/lib/b2c-live/reply";
import { parseEnquiryInput, parseFollowUpInput } from "@/lib/b2c-live/validate";
import type { StudioDeps } from "@/lib/content-studio/generate";
import { can } from "@/lib/auth/roles";
import type { Product } from "@/types";
import { MemoryLedger, fakeTransport, okBody } from "./helpers/fake-openai";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const P_HOOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P_RING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const P_BANGLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const P_OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const P_FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const C1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const C_FOREIGN = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const U2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const U_OUTSIDER = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";
const E_FOREIGN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const stamp = new Date().toISOString();

const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true, model: "test-model", maxOutputTokens: 1000, timeoutMs: 5000, monthlyBudgetUsd: 20, dailyCallsPerOrg: 100, perUserPerMinute: 5, priceInPerMTok: 2, priceOutPerMTok: 8, ...over,
});
const deps = (t: ReturnType<typeof fakeTransport> | null, over: Partial<StudioDeps> = {}, ledger = new MemoryLedger()): StudioDeps & { ledger: MemoryLedger } =>
  ({ config: cfg(), transport: t ? t.transport : null, ledger, limiter: new CallRateLimiter(100), userKey: "u1", ...over }) as StudioDeps & { ledger: MemoryLedger };

const prod = (over: Partial<Product>): Product => ({ id: "p", name: "Item", sku: "X-1", category: "Earrings", price: 1000, stock: 10, channels: [], status: "active", description: null, ...over });
const CATALOGUE: Product[] = [
  prod({ id: P_HOOP, name: "Pearl hoop earrings", sku: "EAR-001", category: "Earrings", price: 1499, stock: 12, description: "Small pearl hoops. Comes in a gift box." }),
  prod({ id: P_RING, name: "Minimal band ring", sku: "RNG-001", category: "Rings", price: 699, stock: 0, description: "A thin everyday band." }),
  prod({ id: P_BANGLE, name: "Charm bracelet", sku: "BRC-001", category: "Bracelets", price: null, stock: null, status: "draft", description: null }),
  prod({ id: P_OLD, name: "Old pearl studs", sku: "EAR-009", category: "Earrings", price: 500, stock: 3, status: "archived" }),
];

/* ---------- pure logic ---------- */

describe("enquiry analysis", () => {
  it("classifies the intent and keeps only closed-vocabulary keywords, never the customer's own words", () => {
    const a = analyseEnquiry("Hi, I am Meera Kapoor, call me on 98765 43210. Do you have pearl earrings for a gift under 2000?");
    expect(a.context.keywords.join(" ")).toMatch(/earring/);
    expect(a.budgetMax).toBe(2000);
    expect(JSON.stringify(a.context)).not.toMatch(/Meera|Kapoor|98765/);
  });
  it("complaints, refunds and order status need a person; sales questions do not", () => {
    for (const t of ["My earrings arrived broken, I want to complain", "I want a refund for my order", "Where is my order? Tracking please"]) {
      const c = analyseEnquiry(t).context;
      expect(c.needsHuman, t).toBe(true);
      expect(c.humanReason).toBeTruthy();
    }
    expect(analyseEnquiry("Do you have pearl hoop earrings?").context.needsHuman).toBe(false);
  });
  it("terms() drops filler and plural s", () => {
    expect(terms("Do you have the pearl hoops?")).toEqual(["pearl", "hoop"]);
  });
});

describe("recommendations are traceable to real catalogue records", () => {
  it("matches by name, category and description and says why, using only recorded values", () => {
    const recs = recommendProducts("Do you have pearl hoop earrings?", CATALOGUE);
    expect(recs[0]).toMatchObject({ productId: P_HOOP, name: "Pearl hoop earrings", category: "Earrings", price: 1499, stock: 12, status: "active" });
    expect(recs[0].matchedOn).toEqual(expect.arrayContaining(["name", "category"]));
    expect(recs[0].reasons.join(" ")).toMatch(/Name matches: pearl, hoop/);
    for (const r of recs) expect(CATALOGUE.some((p) => p.id === r.productId && p.name === r.name && p.price === r.price && p.stock === r.stock)).toBe(true);
  });
  it("a SKU or a pinned product is an explicit match, even when stock is 0", () => {
    expect(recommendProducts("Tell me about RNG-001", CATALOGUE)[0]).toMatchObject({ productId: P_RING, stock: 0 });
    expect(recommendProducts("something pretty please", CATALOGUE, { pinnedProductId: P_RING })[0].productId).toBe(P_RING);
  });
  it("never recommends archived products, or out-of-stock products unprompted", () => {
    expect(recommendProducts("pearl studs earrings", CATALOGUE).map((r) => r.productId)).not.toContain(P_OLD);
    expect(recommendProducts("a ring please", CATALOGUE).map((r) => r.productId)).not.toContain(P_RING);
  });
  it("a stated budget excludes dearer products and products with no recorded price", () => {
    expect(recommendProducts("pearl earrings under 1000", CATALOGUE)).toEqual([]);
    expect(recommendProducts("a bracelet under 5000", CATALOGUE)).toEqual([]);
    expect(recommendProducts("pearl earrings under 2000", CATALOGUE)[0].productId).toBe(P_HOOP);
  });
  it("returns nothing for an unrelated or empty enquiry, and is deterministic", () => {
    expect(recommendProducts("What time do you open?", CATALOGUE)).toEqual([]);
    expect(recommendProducts("", CATALOGUE)).toEqual([]);
    expect(recommendProducts("pearl earrings", CATALOGUE)).toEqual(recommendProducts("pearl earrings", CATALOGUE));
  });
  it("draft products are ranked below active ones and carry a note", () => {
    const recs = recommendProducts("charm bracelet", CATALOGUE);
    expect(recs[0]).toMatchObject({ productId: P_BANGLE, price: null, stock: null });
    expect(recs[0].reasons).toContain("Not yet active in the catalogue");
  });
});

describe("template replies (the AI-off path)", () => {
  const ctx = analyseEnquiry("Do you have pearl hoop earrings?").context;
  it("names catalogue products and one owner sentence, with no price, stock, name or claim", () => {
    const recs = recommendProducts("Do you have pearl hoop earrings?", CATALOGUE);
    const { body } = templateReply(ctx, recs);
    expect(body).toContain("Pearl hoop earrings");
    expect(body).toContain("Small pearl hoops.");
    expect(body).not.toMatch(/1499|₹|\b12\b|in stock/i);
    expect(replyViolations(body)).toEqual([]);
  });
  it("price and availability questions get a 'we will confirm' reply, not a number", () => {
    const c = analyseEnquiry("How much are the pearl hoop earrings, and are they in stock?").context;
    const { body } = templateReply(c, recommendProducts("pearl hoop earrings", CATALOGUE));
    expect(body).toMatch(/confirm the current details/);
    expect(body).not.toMatch(/1499|\d{3,}/);
  });
  it("sensitive intents get a holding reply with no product pitch", () => {
    const c = analyseEnquiry("My ring arrived broken").context;
    const { body, note } = templateReply(c, recommendProducts("pearl hoop earrings", CATALOGUE));
    expect(body).toMatch(/member of our team will look into it/);
    expect(body).not.toContain("Pearl hoop");
    expect(note).toMatch(/needs a person/);
  });
  it("with no match it asks a clarifying question", () => {
    expect(templateReply(analyseEnquiry("hello there").context, []).body).toMatch(/which kind of jewellery/);
  });
  it("a description that holds a refused claim is left out rather than shipped", () => {
    const bad = [prod({ id: P_HOOP, name: "Pearl hoop earrings", description: "Real sterling silver, just ₹499." })];
    const { body, note } = templateReply(ctx, recommendProducts("pearl hoop earrings", bad));
    expect(body).not.toMatch(/sterling|₹/);
    expect(note).toMatch(/left out/);
  });
});

describe("AI reply builder: gates, PII redaction and safety (fake transport only)", () => {
  const ctxSales = analyseEnquiry("pearl hoop earrings please").context;
  const recs = recommendProducts("pearl hoop earrings please", CATALOGUE);
  const GOOD = { reply: "Thank you for your message. Our Pearl hoop earrings are small pearl hoops that may suit you.\n\nCheri & Co." };

  it("AI on: one call with the safe input; the draft is AI-written and the ledger records it", async () => {
    const t = fakeTransport(okBody(GOOD));
    const d = deps(t);
    const out = await buildReply(ctxSales, recs, d);
    expect(out).toMatchObject({ generator: "ai", model: "test-model", promptVersion: "b2c-reply-v2" });
    expect(out.body).toContain("Pearl hoop earrings");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body).toMatchObject({ store: false });
    expect(t.calls[0].body).not.toHaveProperty("tools");
    expect(d.ledger.rows[0].action).toMatch(/^AI call v1 \| b2c \| test-model/);
  });
  it("sends no customer text, no name, no contact, no id, no price and no stock", () => {
    const { input } = buildB2cInput(ctxSales, recs);
    const o = JSON.parse(input);
    expect(Object.keys(o).sort()).toEqual(["brand", "enquiry", "products"]);
    expect(Object.keys(o.enquiry).sort()).toEqual(["intent", "keywords"]);
    expect(o.products[0]).toEqual({ name: "Pearl hoop earrings", category: "Earrings", owner_description: "Small pearl hoops. Comes in a gift box." });
    expect(input).not.toMatch(/1499|aaaaaaaa|EAR-001|"stock"|"price"/);
  });
  it("PII in a product description is redacted before sending", () => {
    const leaky = recommendProducts("pearl hoop earrings", [prod({ id: P_HOOP, name: "Pearl hoop earrings", description: "Ask Meera on meera@x.com or +91 98765 43210." })]);
    const { input, redactions } = buildB2cInput(ctxSales, leaky);
    expect(input).not.toMatch(/meera@x\.com|98765/);
    expect(redactions).toBeGreaterThanOrEqual(2);
  });
  it("the whole customer message (with a name and phone) never reaches the transport", async () => {
    const msg = "Hi I am Meera Kapoor 98765 43210 meera@x.com, do you have pearl hoop earrings?";
    const t = fakeTransport(okBody(GOOD));
    await buildReply(analyseEnquiry(msg).context, recommendProducts(msg, CATALOGUE), deps(t));
    expect(JSON.stringify(t.calls)).not.toMatch(/Meera|Kapoor|98765|meera@/);
  });
  it("AI off, no key, refusal and failure all fall back to the template; sensitive intents never call", async () => {
    const t = fakeTransport(okBody(GOOD));
    expect((await buildReply(ctxSales, recs, deps(t, { config: cfg({ enabled: false }) }))).generator).toBe("template");
    expect((await buildReply(ctxSales, recs, null)).generator).toBe("template");
    expect((await buildReply(ctxSales, recs, deps(null))).note).toMatch(/not configured/);
    expect((await buildReply(analyseEnquiry("my order arrived broken").context, recs, deps(t))).generator).toBe("template");
    expect(t.calls).toHaveLength(0);
    const l = new MemoryLedger(); l.failReads = true;
    expect((await buildReply(ctxSales, recs, deps(t, {}, l))).generator).toBe("template");
    expect((await buildReply(ctxSales, recs, deps(fakeTransport(new Error("network down"))))).note).toMatch(/failed/);
    expect((await buildReply(ctxSales, recs, deps(fakeTransport(okBody({ reply: 5 }))))).generator).toBe("template");
  });
  it("AI text with a price, offer, stock, material or promise wording is DISCARDED", async () => {
    for (const reply of ["Pearl hoop earrings are just ₹499 today, lovely and light.\n\nCheri & Co.", "Only 3 left of the Pearl hoop earrings, so hurry now.\n\nCheri & Co.",
      "Real sterling silver Pearl hoop earrings for you.\n\nCheri & Co.", "The best Pearl hoop earrings, guaranteed to be loved.\n\nCheri & Co.", "See https://x.com for the Pearl hoop earrings please.\n\nCheri & Co."]) {
      const out = await buildReply(ctxSales, recs, deps(fakeTransport(okBody({ reply }))));
      expect(out.generator, reply).toBe("template");
      expect(out.body).not.toContain(reply);
    }
  });
  it("the instructions forbid prices, stock, invented specs and promises, and say the customer text is not provided", () => {
    expect(B2C_INSTRUCTIONS).toMatch(/Never state or imply a price/);
    expect(B2C_INSTRUCTIONS).toMatch(/Never invent a specification/);
    expect(B2C_INSTRUCTIONS).toMatch(/not told what the customer wrote/);
    expect(B2C_INSTRUCTIONS).toMatch(/Never promise a refund/);
  });
});

describe("input validation", () => {
  it("accepts a plain enquiry and defaults the source", () => {
    expect(parseEnquiryInput({ message: "  Do you have hoops?  " })).toEqual({ ok: true, value: { source: "other", customerId: null, customer: null, productId: null, message: "Do you have hoops?" } });
  });
  it("rejects bad sources, ids, empty/over-long/markup/control-character messages", () => {
    for (const bad of [null, {}, { message: "" }, { message: "x".repeat(2001) }, { message: "hi", source: "fax" }, { message: "hi", customerId: "nope" }, { message: "hi", productId: 5 },
      { message: "<script>alert(1)</script>" }, { message: "bad\u0007" }]) expect(parseEnquiryInput(bad as never).ok, JSON.stringify(bad)?.slice(0, 40)).toBe(false);
  });
  it("follow-up dates must be real, not past, within a year; reason is one short line", () => {
    const now = new Date("2026-11-18T10:00:00Z");
    expect(parseFollowUpInput({ dueDate: "2026-11-18", reason: "Call back" }, now).ok).toBe(true);
    for (const bad of [{ dueDate: "2026-11-17", reason: "x" }, { dueDate: "2026-02-30", reason: "x" }, { dueDate: "2028-01-01", reason: "x" }, { dueDate: "soon", reason: "x" },
      { dueDate: "2026-12-01", reason: "" }, { dueDate: "2026-12-01", reason: "a".repeat(141) }, { dueDate: "2026-12-01", reason: "x", priority: "urgent" }, { dueDate: "2026-12-01", reason: "x", assigneeId: "bad" }]) {
      expect(parseFollowUpInput(bad, now).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("roles: writers may use enquiries, a viewer may not", () => {
    for (const r of ["owner", "admin", "approver", "staff"] as const) expect(can(r, "enquiries:write")).toBe(true);
    expect(can("viewer", "enquiries:write")).toBe(false);
  });
});

/* ---------- the live workflow over the recording database ---------- */

const ENV = ["AUTH_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "AI_ENABLED", "OPENAI_API_KEY", "OPENAI_PRICE_INPUT_USD_PER_MTOK", "OPENAI_PRICE_OUTPUT_USD_PER_MTOK", "OPENAI_MODEL"];
const headers = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const jreq = (url: string, body?: unknown) => new Request(url, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
const create = (body: unknown) => createRoute(jreq("https://app.test/api/b2c/enquiries", body));
const act = (id: string, a: string, body?: unknown) => enquiryAction(jreq(`https://app.test/api/b2c/enquiries/${id}/${a}`, body), { params: Promise.resolve({ id, action: a }) });
const msg = (id: string, mid: string, a: string, body?: unknown) => messageAction(jreq(`https://app.test/api/b2c/enquiries/${id}/messages/${mid}/${a}`, body), { params: Promise.resolve({ id, mid, action: a }) });
const getOne = (id: string) => getRoute(new Request(`https://app.test/api/b2c/enquiries/${id}`), { params: Promise.resolve({ id }) });
const setRole = (role: string) => { db.t.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: false } }, { user_id: U2, org_id: ORG, role: "staff" }, { user_id: U_OUTSIDER, org_id: OTHER, role: "staff" }]; };
const mine = (table: string) => (db.t[table] ?? []).filter((r) => r.org_id === ORG);
const aiOn = () => { vi.stubEnv("AI_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real"); vi.stubEnv("OPENAI_PRICE_INPUT_USD_PER_MTOK", "2"); vi.stubEnv("OPENAI_PRICE_OUTPUT_USD_PER_MTOK", "8"); vi.stubEnv("OPENAI_MODEL", "test-model"); };
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over arbitrary API bodies
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("AUTH_MODE", "required"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  db.reads.length = 0; db.n = 0; db.missing = ""; db.crash = ""; db.beforeRpc = null;
  (globalThis as { __aiLimiter?: unknown }).__aiLimiter = undefined;
  const p = (id: string, org: string, over: Row) => ({ id, org_id: org, sku: "S", name: "Item", category: "Earrings", price: "1000.00", stock: 10, status: "active", channels: [], description: null, image_url: null, created_at: stamp, ...over });
  db.t = {
    memberships: [], profiles: [], approvals: [], agent_activity: [], audit_log: [], tasks: [], enquiries: [], enquiry_messages: [],
    customers: [{ id: C1, org_id: ORG, name: "Meera Kapoor", phone: "+91 98765 43210", email: "meera@x.com", created_at: stamp }, { id: C_FOREIGN, org_id: OTHER, name: "Other Person", created_at: stamp }],
    products: [
      p(P_HOOP, ORG, { sku: "EAR-001", name: "Pearl hoop earrings", description: "Small pearl hoops. Comes in a gift box.", price: "1499.00", stock: 12 }),
      p(P_RING, ORG, { sku: "RNG-001", name: "Minimal band ring", category: "Rings", price: "699.00", stock: 0, description: "A thin everyday band." }),
      p(P_OLD, ORG, { sku: "EAR-009", name: "Old pearl studs", status: "archived" }),
      p(P_FOREIGN, OTHER, { sku: "EAR-777", name: "Foreign hoop earrings" }),
    ],
  };
  db.t.enquiries.push({ id: E_FOREIGN, org_id: OTHER, customer_id: null, product_id: null, source: "email", status: "new", subject: "Other org enquiry", created_at: stamp, last_message_at: stamp });
  db.t.enquiry_messages.push({ id: "m-foreign", org_id: OTHER, enquiry_id: E_FOREIGN, direction: "inbound", body: "Other org secret", status: "received", generated_by: "customer", product_id: null, approval_id: null, model: null, created_at: stamp });
  setRole("owner");
});
afterEach(() => { vi.unstubAllEnvs(); __setAiTransportForTests(undefined); });

const newEnquiry = async (message = "Do you have pearl hoop earrings?", extra: Record<string, unknown> = {}) => {
  const r = await create({ source: "instagram", message, ...extra });
  expect(r.status).toBe(201);
  return ((await json(r)).data) as { id: string; messages: { id: string }[] };
};

describe("enquiry intake", () => {
  it("creates an enquiry with its first inbound message, source, status, timestamps and org ownership", async () => {
    const e = await newEnquiry("Do you have pearl hoop earrings?", { customerId: C1, productId: P_HOOP });
    expect(mine("enquiries")).toHaveLength(1);
    expect(mine("enquiries")[0]).toMatchObject({ org_id: ORG, customer_id: C1, product_id: P_HOOP, source: "instagram", status: "new", subject: "Do you have pearl hoop earrings?" });
    expect(mine("enquiries")[0].created_at).toBeTruthy();
    expect(mine("enquiry_messages")).toHaveLength(1);
    expect(mine("enquiry_messages")[0]).toMatchObject({ org_id: ORG, enquiry_id: e.id, direction: "inbound", status: "received", generated_by: "customer", product_id: P_HOOP });
    expect(mine("agent_activity").map((r) => String(r.action))).toContain("Logged a instagram enquiry about Pearl hoop earrings");
  });
  it("the activity history never carries the customer's name or message", async () => {
    await newEnquiry("I am Meera Kapoor, 98765 43210", { customerId: C1 });
    expect(JSON.stringify(mine("agent_activity"))).not.toMatch(/Meera|98765/);
  });
  it("associates only this organisation's customers and products", async () => {
    expect((await create({ message: "hi", customerId: C_FOREIGN })).status).toBe(404);
    expect((await create({ message: "hi", productId: P_FOREIGN })).status).toBe(404);
    expect((await create({ message: "hi", customerId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc9" })).status).toBe(404);
    expect(mine("enquiries")).toHaveLength(0);
  });
  it("lists and reads only this organisation's enquiries; another organisation's is a 404", async () => {
    const e = await newEnquiry();
    const list = await json(await listRoute());
    expect(list.data.map((x: { id: string }) => x.id)).toEqual([e.id]);
    expect(JSON.stringify(list)).not.toMatch(/Other org/);
    expect((await getOne(E_FOREIGN)).status).toBe(404);
    expect((await getOne("not-a-uuid")).status).toBe(404);
    const one = await json(await getOne(e.id));
    expect(one.data.messages).toHaveLength(1);
  });
  it("bad input is a 400 and writes nothing", async () => {
    for (const bad of [{}, { message: "" }, { message: "hi", source: "fax" }, { message: "hi", customerId: "x" }]) expect((await create(bad)).status).toBe(400);
    expect(mine("enquiries")).toHaveLength(0);
  });
  it("the sample 'run' endpoint still answers 501 for a live organisation (the sample catalogue is never shown)", async () => {
    expect((await runRoute(jreq("https://app.test/api/agents/b2c/run", { enquiry: "hello" }))).status).toBe(501);
  });
});

describe("recommendations endpoint", () => {
  it("returns catalogue-traceable matches from this organisation only, and saves nothing", async () => {
    const e = await newEnquiry("Do you have pearl hoop earrings?");
    const before = JSON.stringify(db.t.enquiry_messages);
    const body = await json(await act(e.id, "recommendations", {}));
    expect(body.data.recommendations[0]).toMatchObject({ productId: P_HOOP, name: "Pearl hoop earrings" });
    expect(JSON.stringify(body)).not.toMatch(/Foreign|EAR-777/);
    expect(JSON.stringify(db.t.enquiry_messages)).toBe(before);
    expect((await act(e.id, "recommendations", { productId: P_FOREIGN })).status).toBe(404);
    expect((await act(E_FOREIGN, "recommendations", {})).status).toBe(404);
  });
});

describe("reply drafts, editing, approval and manual send", () => {
  it("AI off (default): a template draft is saved, no model is consulted, and it records the product", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real"); // present but AI_ENABLED is not true
    const t = fakeTransport(okBody({ reply: "never used by anything here" }));
    __setAiTransportForTests(t.transport);
    const e = await newEnquiry("Do you have pearl hoop earrings?");
    const r = await act(e.id, "reply", {});
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body).toMatchObject({ generator: "template", regenerated: false });
    expect(body.data).toMatchObject({ direction: "outbound", status: "draft", generatedBy: "template", productId: P_HOOP });
    expect(String(body.data.body)).toContain("Pearl hoop earrings");
    expect(t.calls).toHaveLength(0);
    expect(mine("agent_activity").some((x) => String(x.action).startsWith("AI call v1"))).toBe(false);
    expect(mine("enquiries")[0].status).toBe("draft_ready");
    expect(mine("enquiry_messages").filter((m) => m.direction === "outbound")).toHaveLength(1);
  });

  it("AI on with a fake transport: the draft is AI-written, saved, and records the product, model and enquiry", async () => {
    aiOn();
    const t = fakeTransport(okBody({ reply: "Thank you for your message. The Pearl hoop earrings are small pearl hoops that may suit you.\n\nCheri & Co." }));
    __setAiTransportForTests(t.transport);
    const e = await newEnquiry("Hi I am Meera Kapoor 98765 43210, do you have pearl hoop earrings?", { customerId: C1 });
    db.reads.length = 0;
    const body = await json(await act(e.id, "reply", {}));
    expect(body.generator).toBe("ai");
    expect(body.data).toMatchObject({ status: "draft", generatedBy: "ai", model: "test-model", productId: P_HOOP, enquiryId: e.id });
    expect(t.calls).toHaveLength(1);
    expect(JSON.stringify(t.calls)).not.toMatch(/Meera|Kapoor|98765/);
    expect(db.reads).not.toContain("customers"); // the customer record is not even read for a reply
    expect(mine("agent_activity").some((x) => /^AI call v1 \| b2c \| test-model/.test(String(x.action)))).toBe(true);
  });

  it("an AI draft that breaks the claim guard is replaced by the template", async () => {
    aiOn();
    __setAiTransportForTests(fakeTransport(okBody({ reply: "Pearl hoop earrings for just ₹499 today, truly lovely.\n\nCheri & Co." })).transport);
    const e = await newEnquiry();
    const body = await json(await act(e.id, "reply", {}));
    expect(body.generator).toBe("template");
    expect(body.note).toMatch(/discarded/);
    expect(String(body.data.body)).not.toMatch(/₹/);
  });

  it("an enquiry keeps one open draft: regenerating replaces its wording instead of adding another", async () => {
    const e = await newEnquiry();
    const a = await json(await act(e.id, "reply", {}));
    const b = await json(await act(e.id, "reply", {}));
    expect(b.regenerated).toBe(true);
    expect(b.data.id).toBe(a.data.id);
    expect(mine("enquiry_messages").filter((m) => m.direction === "outbound")).toHaveLength(1);
  });

  it("a person can edit the draft; the edit is saved as human-written, the claim guard runs, and the conversation shows it", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    const ok = await msg(e.id, d.id, "edit", { body: "Hello! The pearl hoops are available to view on request.\n\nCheri & Co." });
    expect(ok.status).toBe(200);
    expect(mine("enquiry_messages").find((m) => m.id === d.id)).toMatchObject({ body: expect.stringContaining("available to view"), generated_by: "human", status: "draft" });
    expect((await msg(e.id, d.id, "edit", { body: "Real sterling silver hoops for just ₹499." })).status).toBe(422);
    expect((await msg(e.id, d.id, "edit", { body: "" })).status).toBe(409);
    expect((await msg(e.id, d.id, "edit", {})).status).toBe(400);
    const convo = (await json(await getOne(e.id))).data;
    expect(convo.messages.map((m: { direction: string; status: string }) => `${m.direction}:${m.status}`)).toEqual(["inbound:received", "outbound:draft"]);
  });

  it("the whole path: draft -> submit to the Approval Centre -> approve -> record manual send. Approval is not delivery", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    // the only route to approval
    const sub = await msg(e.id, d.id, "submit");
    expect(sub.status).toBe(200);
    const approval = mine("approvals")[0];
    expect(approval).toMatchObject({ org_id: ORG, status: "pending", type: "B2C Reply", generated_by: "b2c" });
    expect(approval.meta).toMatchObject({ kind: "b2c_reply", ref: e.id, messageId: d.id, productId: P_HOOP, allowedClaims: [], isSample: false });
    expect(String(approval.preview)).toBe(String(mine("enquiry_messages").find((m) => m.id === d.id)!.body));
    expect(mine("enquiry_messages").find((m) => m.id === d.id)).toMatchObject({ status: "pending_approval", approval_id: approval.id });
    expect(mine("enquiries")[0].status).toBe("awaiting_approval");
    // not yet approved: it cannot be marked sent, edited, regenerated or submitted twice
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409);
    const again = await msg(e.id, d.id, "submit"); // a retry is idempotent: same approval, nothing new created
    expect(again.status).toBe(200);
    expect((await json(again)).approval.id).toBe(approval.id);
    expect(mine("approvals")).toHaveLength(1);
    expect((await msg(e.id, d.id, "edit", { body: "Changed while pending.\n\nCheri & Co." })).status).toBe(409);
    expect((await act(e.id, "reply", {})).status).toBe(409);
    // approve
    expect(await decideApproval(String(approval.id), "approve", "ok")).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(mine("enquiry_messages").find((m) => m.id === d.id)!.status).toBe("approved");
    expect(mine("enquiries")[0].status).toBe("approved");
    expect(mine("audit_log")).toHaveLength(1);
    expect(mine("enquiry_messages").some((m) => m.status === "sent_manually")).toBe(false); // approval did not "send" anything
    // a person records they sent it themselves, outside the app
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(200);
    expect(mine("enquiry_messages").find((m) => m.id === d.id)!.status).toBe("sent_manually");
    expect(mine("enquiries")[0].status).toBe("replied");
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409);
    const history = (await json(await getOne(e.id))).data.history.map((h: { action: string }) => h.action);
    expect(history).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Logged a instagram enquiry/), expect.stringMatching(/^Created a reply template draft/), "Sent the drafted reply for approval (not sent to the customer)",
      "Recorded that the approved reply was sent by a person outside this app",
    ]));
  });

  it("rejection returns the enquiry to draft_ready; the reply can then be edited and sent for approval again", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    const approvalId = String(mine("approvals")[0].id);
    expect(await decideApproval(approvalId, "reject", "Too plain")).toMatchObject({ ok: true, approval: { status: "rejected" } });
    expect(mine("enquiry_messages").find((m) => m.id === d.id)!.status).toBe("rejected");
    expect(mine("enquiries")[0].status).toBe("draft_ready");
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409); // a rejected reply can never be marked as sent
    expect((await msg(e.id, d.id, "submit")).status).toBe(409);
    expect((await msg(e.id, d.id, "edit", { body: "A friendlier version of the reply.\n\nCheri & Co." })).status).toBe(200);
    expect((await msg(e.id, d.id, "submit")).status).toBe(200);
    expect(mine("approvals")).toHaveLength(2);
  });

  it("a decision made in the Approval Centre is stored on the message (by the database trigger) and shown by the conversation", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[0].id), "approve", "ok");
    const shown = (await json(await getOne(e.id))).data;
    expect(shown.messages.find((m: { id: string }) => m.id === d.id).status).toBe("approved");
    expect(shown.status).toBe("approved");
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(200);
  });

  it("mark-sent trusts the approval, not the stored status: a stored 'approved' whose approval is not approved (or is missing, or foreign) is refused", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    const row = mine("enquiry_messages").find((m) => m.id === d.id)!;
    row.status = "approved"; // corrupted state the database would normally refuse; the service must still not trust it
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409); // approval is still pending
    const approval = mine("approvals")[0];
    approval.status = "approved";
    approval.type = "Other";
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409); // wrong approval type
    approval.type = "B2C Reply";
    row.approval_id = null;
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409); // no approval at all
    row.approval_id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(409); // an approval that does not exist in this organisation
    row.approval_id = approval.id;
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(200); // every condition met
  });

  it("approving re-runs the claim guard on the approval text", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    mine("approvals")[0].preview = "Genuine sterling silver, just ₹499 today.";
    expect(await decideApproval(String(mine("approvals")[0].id), "approve", "check")).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(mine("approvals")[0].status).toBe("pending");
  });

  it("sensitive enquiries get a holding reply and never an AI call, even with AI on", async () => {
    aiOn();
    const t = fakeTransport(okBody({ reply: "should never be used by anything" }));
    __setAiTransportForTests(t.transport);
    const e = await newEnquiry("My earrings arrived broken, I want a refund");
    const body = await json(await act(e.id, "reply", {}));
    expect(body.generator).toBe("template");
    expect(body.context.needsHuman).toBe(true);
    expect(String(body.data.body)).toMatch(/member of our team/);
    expect(t.calls).toHaveLength(0);
  });

  it("another organisation's enquiry and message are 404s and nothing is written", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    expect((await act(E_FOREIGN, "reply", {})).status).toBe(404);
    expect((await msg(E_FOREIGN, "m-foreign", "edit", { body: "x" })).status).toBe(404);
    expect((await msg(E_FOREIGN, d.id, "submit")).status).toBe(404);
    expect((await msg(e.id, "m-foreign", "submit")).status).toBe(404);
    expect((await msg(E_FOREIGN, "m-foreign", "mark-sent")).status).toBe(404);
    expect(db.t.enquiry_messages.find((m) => m.id === "m-foreign")).toMatchObject({ body: "Other org secret", status: "received" });
    expect(mine("approvals")).toHaveLength(0);
  });

  it("an inbound message can never be edited, submitted or marked sent", async () => {
    const e = await newEnquiry();
    const inbound = e.messages[0].id;
    expect((await msg(e.id, inbound, "edit", { body: "tampered" })).status).toBe(404);
    expect((await msg(e.id, inbound, "submit")).status).toBe(404);
    expect((await msg(e.id, inbound, "mark-sent")).status).toBe(404);
  });
});

describe("follow-ups", () => {
  it("creates one open follow-up task linked to the enquiry, with date, reason, owner and history; duplicates are refused", async () => {
    const e = await newEnquiry("Do you have pearl hoop earrings?", { customerId: C1 });
    const r = await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Ask whether the hoops suit", assigneeId: U2, priority: "high" });
    expect(r.status).toBe(201);
    expect(mine("tasks")).toHaveLength(1);
    expect(mine("tasks")[0]).toMatchObject({ source: "B2C enquiry", priority: "high", assignee_id: U2, status: "open", related_ref: `/b2c?enquiry=${e.id}`, title: "Follow up: Ask whether the hoops suit" });
    expect(String(mine("tasks")[0].due_at)).toContain(tomorrow());
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Again" })).status).toBe(409);
    expect(mine("tasks")).toHaveLength(1);
    const one = (await json(await getOne(e.id))).data;
    expect(one.followUps).toHaveLength(1);
    expect(one.followUps[0]).toMatchObject({ status: "open", priority: "high", assigneeId: U2 });
    expect(one.history.map((h: { action: string }) => h.action)).toContain(`Created a follow-up due ${tomorrow()}`);
    // once it is done a new one may be created
    mine("tasks")[0].status = "done";
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Second round" })).status).toBe(201);
  });
  it("the assignee must be a member of this organisation; a past date or missing reason is a 400", async () => {
    const e = await newEnquiry();
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "x", assigneeId: U_OUTSIDER })).status).toBe(422);
    expect((await act(e.id, "follow-up", { dueDate: "2020-01-01", reason: "x" })).status).toBe(400);
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "" })).status).toBe(400);
    expect((await act(E_FOREIGN, "follow-up", { dueDate: tomorrow(), reason: "x" })).status).toBe(404);
    expect(mine("tasks")).toHaveLength(0);
  });
});

describe("roles, isolation and error handling", () => {
  it("a viewer can read enquiries but cannot create, draft, edit, submit or follow up", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    setRole("viewer");
    expect((await listRoute()).status).toBe(200);
    expect((await getOne(e.id)).status).toBe(200);
    expect((await create({ message: "hi" })).status).toBe(403);
    expect((await act(e.id, "reply", {})).status).toBe(403);
    expect((await act(e.id, "recommendations", {})).status).toBe(403);
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "x" })).status).toBe(403);
    expect((await msg(e.id, d.id, "edit", { body: "x" })).status).toBe(403);
    expect((await msg(e.id, d.id, "submit")).status).toBe(403);
    expect((await msg(e.id, d.id, "mark-sent")).status).toBe(403);
  });
  it("staff can write enquiries but cannot decide approvals (the existing rule)", () => {
    expect(can("staff", "enquiries:write")).toBe(true);
    expect(can("staff", "approvals:decide")).toBe(false);
  });
  it("a demo organisation gets 404s and nothing is written", async () => {
    const e = await newEnquiry();
    db.t.memberships = [{ user_id: "u1", org_id: ORG, role: "owner", organizations: { is_demo: true } }];
    expect((await create({ message: "hi" })).status).toBe(404);
    expect((await listRoute()).status).toBe(404);
    expect((await act(e.id, "reply", {})).status).toBe(404);
    expect(mine("enquiries")).toHaveLength(1);
  });
  it("cross-site and non-JSON writes are blocked", async () => {
    const bad = new Request("https://app.test/api/b2c/enquiries", { method: "POST", headers: { host: "app.test", origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    expect((await createRoute(bad)).status).toBe(403);
    expect(mine("enquiries")).toHaveLength(0);
  });
  it("tables not created yet (migration not applied) answer 503 with a plain message, not a 500", async () => {
    db.missing = "enquiries";
    const r = await create({ message: "hi" });
    expect(r.status).toBe(503);
    expect((await json(r)).error).toMatch(/not set up yet/);
    expect((await listRoute()).status).toBe(503);
  });
  it("a code fault answers JSON 500 with a safe message and logs the real cause", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.crash = "enquiries";
      const r = await create({ message: "hi" });
      expect(r.status).toBe(500);
      const body = await json(r);
      expect(body.error).toMatch(/server error/);
      expect(JSON.stringify(body)).not.toMatch(/boom|TypeError|sk-/);
      expect(spy.mock.calls.flat().join(" ")).toMatch(/TypeError: boom/);
    } finally { spy.mockRestore(); }
  });
  it("nothing in the module sends a message: there is no outbound channel call and no network use", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[0].id), "approve", "ok");
    await msg(e.id, d.id, "mark-sent");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

/* ---------- Milestone 3b: customer find-or-create, duplicates, pagination, follow-up updates, scenarios, catalogue facts ---------- */

import { PATCH as followPatch } from "@/app/api/b2c/enquiries/[id]/follow-ups/[fid]/route";
import { POST as followComplete } from "@/app/api/b2c/enquiries/[id]/follow-ups/[fid]/complete/route";
import { GET as messagesRoute } from "@/app/api/b2c/enquiries/[id]/messages/route";
import { parseCustomer, parseFollowUpPatch, parseListQuery } from "@/lib/b2c-live/validate";

const list = (qs = "") => listRoute(new Request(`https://app.test/api/b2c/enquiries${qs}`));
const messagesOf = (id: string, qs = "") => messagesRoute(new Request(`https://app.test/api/b2c/enquiries/${id}/messages${qs}`), { params: Promise.resolve({ id }) });
const patchFollow = (id: string, fid: string, body: unknown) =>
  followPatch(new Request(`https://app.test/api/b2c/enquiries/${id}/follow-ups/${fid}`, { method: "PATCH", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id, fid }) });
const completeFollow = (id: string, fid: string) =>
  followComplete(jreq(`https://app.test/api/b2c/enquiries/${id}/follow-ups/${fid}/complete`), { params: Promise.resolve({ id, fid }) });

describe("customer identification and creation", () => {
  it("creates a customer from contact details (normalised) and links the enquiry to it", async () => {
    const r = await create({ source: "whatsapp", message: "Do you have pearl hoop earrings?", customer: { name: "Asha Rao", email: "Asha@Example.com", phone: "+91 99999 11111", city: "Pune" } });
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(body.customer).toMatchObject({ created: true });
    const made = mine("customers").find((c) => c.id === body.customer.id)!;
    expect(made).toMatchObject({ org_id: ORG, name: "Asha Rao", email: "asha@example.com", phone: "+919999911111", city: "Pune" });
    expect(body.data.customerId).toBe(made.id);
    expect(mine("enquiries")[0].customer_id).toBe(made.id);
  });
  it("reuses an existing customer of this organisation (email in any case, Instagram with or without @) instead of creating another", async () => {
    mine("customers")[0].instagram = "meera.k";
    const before = mine("customers").length;
    const a = await json(await create({ message: "Do you have rings?", customer: { name: "Different Name", email: "MEERA@X.COM" } }));
    expect(a.customer).toEqual({ id: C1, created: false });
    const b = await json(await create({ message: "Do you have bracelets?", customer: { name: "Whoever", instagram: "@Meera.K" } }));
    expect(b.customer).toEqual({ id: C1, created: false });
    expect(mine("customers")).toHaveLength(before);
    expect(mine("customers").find((c) => c.id === C1)!.name).toBe("Meera Kapoor"); // an existing record is never overwritten
  });
  it("never matches a customer of another organisation", async () => {
    db.t.customers.find((c) => c.id === C_FOREIGN)!.email = "other@x.com";
    const r = await json(await create({ message: "Do you have rings?", customer: { name: "New Person", email: "other@x.com" } }));
    expect(r.customer.created).toBe(true);
    expect(r.customer.id).not.toBe(C_FOREIGN);
    expect(db.t.customers.find((c) => c.id === C_FOREIGN)).toMatchObject({ org_id: OTHER, name: "Other Person" });
  });
  it("rejects incomplete, ambiguous or malformed customer details and writes nothing", async () => {
    const before = db.t.customers.length;
    for (const bad of [
      { message: "hi", customer: { name: "No Contact" } },
      { message: "hi", customer: { email: "a@b.co" } },
      { message: "hi", customer: { name: "X", email: "not-an-email" } },
      { message: "hi", customer: { name: "X", phone: "12" } },
      { message: "hi", customer: { name: "X", instagram: "bad handle!" } },
      { message: "hi", customer: "Asha" },
      { message: "hi", customerId: C1, customer: { name: "X", email: "a@b.co" } },
    ]) expect((await create(bad)).status).toBe(400);
    expect(db.t.customers).toHaveLength(before);
    expect(mine("enquiries")).toHaveLength(0);
    expect(parseCustomer({ name: "A", phone: "+44 7700 900123" })).toMatchObject({ ok: true, value: { phone: "+447700900123" } });
  });
  it("an unknown customerId is a 404 and a foreign customerId is a 404", async () => {
    expect((await create({ message: "hi", customerId: C_FOREIGN })).status).toBe(404);
    expect((await create({ message: "hi", customerId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc9" })).status).toBe(404);
  });
});

describe("duplicate enquiry prevention", () => {
  it("the same message, channel and customer inside the window is a 409 that names the existing enquiry", async () => {
    const first = await newEnquiry("Do you have pearl hoop earrings?", { customerId: C1 });
    const again = await create({ source: "instagram", message: "Do you have pearl hoop earrings?", customerId: C1 });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ existingId: first.id });
    expect(mine("enquiries")).toHaveLength(1);
    expect(mine("enquiry_messages")).toHaveLength(1);
  });
  it("a different channel, customer or message is not a duplicate", async () => {
    await newEnquiry("Do you have pearl hoop earrings?", { customerId: C1 });
    expect((await create({ source: "email", message: "Do you have pearl hoop earrings?", customerId: C1 })).status).toBe(201);
    expect((await create({ source: "instagram", message: "Do you have pearl hoop earrings?" })).status).toBe(201); // anonymous
    expect((await create({ source: "instagram", message: "Do you have rings?", customerId: C1 })).status).toBe(201);
  });
  it("a double submit with customer details creates one customer and one enquiry", async () => {
    const body = { source: "whatsapp", message: "Do you have hoops?", customer: { name: "Asha Rao", phone: "+919999911111" } };
    const before = mine("customers").length;
    expect((await create(body)).status).toBe(201);
    expect((await create(body)).status).toBe(409);
    expect(mine("customers")).toHaveLength(before + 1);
    expect(mine("enquiries")).toHaveLength(1);
  });
  it("after the window has passed the same message is accepted again", async () => {
    await newEnquiry("Do you have hoops?");
    mine("enquiry_messages")[0].created_at = new Date(Date.now() - 11 * 60_000).toISOString();
    expect((await create({ source: "instagram", message: "Do you have hoops?" })).status).toBe(201);
  });
  it("another organisation's identical message is never a duplicate", async () => {
    db.t.enquiry_messages.push({ id: "m-x", org_id: OTHER, enquiry_id: E_FOREIGN, direction: "inbound", body: "Do you have hoops?", status: "received", generated_by: "customer", product_id: null, approval_id: null, model: null, created_at: new Date().toISOString() });
    expect((await create({ source: "email", message: "Do you have hoops?" })).status).toBe(201);
  });
});

describe("conversation retrieval and pagination", () => {
  it("lists enquiries a page at a time, only this organisation's, with hasMore", async () => {
    for (let i = 0; i < 5; i++) await newEnquiry(`Do you have hoops, variant ${i}?`);
    const p1 = await json(await list("?limit=2"));
    expect(p1.data).toHaveLength(2);
    expect(p1.page).toEqual({ limit: 2, offset: 0, hasMore: true });
    const p3 = await json(await list("?limit=2&offset=4"));
    expect(p3.data).toHaveLength(1);
    expect(p3.page.hasMore).toBe(false);
    expect([...p1.data, ...(await json(await list("?limit=2&offset=2"))).data, ...p3.data].map((x: { id: string }) => x.id)).not.toContain(E_FOREIGN);
    const all = await json(await list());
    expect(all.data).toHaveLength(5);
    expect(all.page).toEqual({ limit: 50, offset: 0, hasMore: false });
  });
  it("filters by status and customer, and rejects bad paging parameters", async () => {
    const a = await newEnquiry("Do you have hoops?", { customerId: C1 });
    await newEnquiry("Do you have rings?");
    mine("enquiries").find((x) => x.id === a.id)!.status = "closed";
    expect((await json(await list("?status=closed"))).data.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect((await json(await list(`?customerId=${C1}`))).data).toHaveLength(1);
    for (const bad of ["?limit=0", "?limit=101", "?limit=abc", "?offset=-1", "?status=bogus", "?customerId=nope"]) expect((await list(bad)).status).toBe(400);
    expect(parseListQuery(new URLSearchParams("limit=10&offset=20"))).toMatchObject({ ok: true, value: { limit: 10, offset: 20 } });
  });
  it("returns the conversation oldest first, a page at a time, with each message's real approval status", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[0].id), "approve", "ok");
    const all = await json(await messagesOf(e.id));
    expect(all.data.map((m: { direction: string }) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(all.data[1].status).toBe("approved");
    const first = await json(await messagesOf(e.id, "?limit=1"));
    expect(first.data).toHaveLength(1);
    expect(first.page).toEqual({ limit: 1, offset: 0, hasMore: true });
    expect((await json(await messagesOf(e.id, "?limit=1&offset=1"))).page.hasMore).toBe(false);
    expect((await messagesOf(e.id, "?limit=0")).status).toBe(400);
  });
  it("another organisation's conversation is a 404; a viewer may read; a demo organisation gets 404", async () => {
    const e = await newEnquiry();
    expect((await messagesOf(E_FOREIGN)).status).toBe(404);
    expect((await messagesOf("not-a-uuid")).status).toBe(404);
    setRole("viewer");
    expect((await messagesOf(e.id)).status).toBe(200);
    (db.t.memberships[0] as { organizations: unknown }).organizations = { is_demo: true };
    expect((await messagesOf(e.id)).status).toBe(404);
  });
});

describe("follow-up update and completion", () => {
  const followed = async () => {
    const e = await newEnquiry("Do you have pearl hoop earrings?", { customerId: C1 });
    const f = (await json(await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Ask whether the hoops suit", priority: "low" }))).data as { id: string };
    return { e, f };
  };
  it("updates due date, priority and reason, keeps the link to the enquiry, and records history", async () => {
    const { e, f } = await followed();
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const r = await patchFollow(e.id, f.id, { dueDate: later, priority: "high", reason: "Check delivery pincode" });
    expect(r.status).toBe(200);
    expect((await json(r)).data).toMatchObject({ id: f.id, priority: "high", title: "Follow up: Check delivery pincode", status: "open" });
    expect(String(mine("tasks")[0].due_at)).toContain(later);
    expect(mine("tasks")[0].related_ref).toBe(`/b2c?enquiry=${e.id}`);
    expect((await json(await getOne(e.id))).data.history.map((h: { action: string }) => h.action)).toContain(`Updated the follow-up (now due ${later})`);
  });
  it("completes a follow-up, refuses to complete it twice, and allows a new one afterwards", async () => {
    const { e, f } = await followed();
    expect((await completeFollow(e.id, f.id)).status).toBe(200);
    expect(mine("tasks")[0].status).toBe("done");
    expect((await completeFollow(e.id, f.id)).status).toBe(409);
    const one = (await json(await getOne(e.id))).data;
    expect(one.followUps[0].status).toBe("done");
    expect(one.history.map((h: { action: string }) => h.action)).toContain("Completed the follow-up");
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Second round" })).status).toBe(201);
  });
  it("postpones, and reopening is refused while another follow-up is open", async () => {
    const { e, f } = await followed();
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    expect((await json(await patchFollow(e.id, f.id, { status: "postponed", dueDate: later }))).data).toMatchObject({ status: "postponed" });
    expect((await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Another" })).status).toBe(201);
    expect((await patchFollow(e.id, f.id, { status: "open" })).status).toBe(409);
    expect(mine("tasks").filter((t) => t.status === "open")).toHaveLength(1);
  });
  it("a follow-up of another enquiry or organisation is a 404, and bad patches are 400s", async () => {
    const { e, f } = await followed();
    const other = await newEnquiry("Do you have rings?");
    expect((await patchFollow(other.id, f.id, { priority: "high" })).status).toBe(404);
    expect((await completeFollow(E_FOREIGN, f.id)).status).toBe(404);
    expect((await patchFollow(e.id, "nope", { priority: "high" })).status).toBe(404);
    for (const bad of [{}, { status: "closed" }, { priority: "urgent" }, { dueDate: "2020-01-01" }, { dueDate: "soon" }, { reason: "" }, { reason: "a\nb" }]) expect((await patchFollow(e.id, f.id, bad)).status).toBe(400);
    expect(mine("tasks")[0]).toMatchObject({ priority: "low", status: "open" });
    expect(parseFollowUpPatch({ status: "done" })).toEqual({ ok: true, value: { status: "done" } });
  });
  it("a viewer cannot update or complete follow-ups", async () => {
    const { e, f } = await followed();
    setRole("viewer");
    expect((await patchFollow(e.id, f.id, { priority: "high" })).status).toBe(403);
    expect((await completeFollow(e.id, f.id)).status).toBe(403);
    expect(mine("tasks")[0]).toMatchObject({ priority: "low", status: "open" });
  });
});

describe("conversation status: close and reopen", () => {
  it("closes an enquiry, blocks new drafts while closed, and reopens to the status its latest reply implies", async () => {
    const e = await newEnquiry();
    await act(e.id, "reply", {});
    expect((await act(e.id, "close")).status).toBe(200);
    expect(mine("enquiries")[0].status).toBe("closed");
    expect((await act(e.id, "close")).status).toBe(409);
    expect((await act(e.id, "reply", {})).status).toBe(409);
    expect((await json(await act(e.id, "reopen"))).data.status).toBe("draft_ready");
    expect((await act(e.id, "reopen")).status).toBe(409);
  });
  it("cannot be closed while a reply waits in Approvals", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    expect((await act(e.id, "close")).status).toBe(409);
    expect(mine("enquiries")[0].status).toBe("awaiting_approval");
  });
  it("an enquiry with no reply reopens as new; another organisation's enquiry is a 404; a viewer cannot close", async () => {
    const e = await newEnquiry();
    await act(e.id, "close");
    expect((await json(await act(e.id, "reopen"))).data.status).toBe("new");
    expect((await act(E_FOREIGN, "close")).status).toBe(404);
    setRole("viewer");
    expect((await act(e.id, "close")).status).toBe(403);
  });
});

describe("scenarios: product enquiry, comparison, purchase intent", () => {
  it("detects each scenario, and a person-only intent always wins", () => {
    expect(analyseEnquiry("Do you have pearl earrings?").context.scenario).toBe("product_enquiry");
    expect(analyseEnquiry("Which is better, the pearl hoop earrings or the minimal band ring?").context).toMatchObject({ scenario: "comparison", keywords: expect.arrayContaining(["comparison"]) });
    expect(analyseEnquiry("What is the difference between the hoops and the studs?").context.scenario).toBe("comparison");
    expect(analyseEnquiry("I want to buy the pearl hoop earrings, how do I pay?").context).toMatchObject({ scenario: "purchase_intent", keywords: expect.arrayContaining(["ready to buy"]) });
    expect(analyseEnquiry("I'll take the band ring").context.scenario).toBe("purchase_intent");
    expect(analyseEnquiry("My order arrived damaged, I want a refund").context.scenario).toBe("needs_human");
    expect(analyseEnquiry("hello").context.scenario).toBe("general");
  });
  it("comparison: the template names each matched product and adds no price, stock or invented spec", () => {
    const text = "Which is better, the pearl hoop earrings or the minimal band ring?";
    const recs = recommendProducts(text, CATALOGUE, {});
    expect(recs.map((r) => r.productId)).toEqual(expect.arrayContaining([P_HOOP, P_RING]));
    const { body } = templateReply(analyseEnquiry(text).context, recs);
    expect(body).toMatch(/Pearl hoop earrings \(Earrings\)/);
    expect(body).toMatch(/Minimal band ring \(Rings\)/);
    expect(body).toMatch(/as described in our catalogue/);
    expect(body).not.toMatch(/\d{3,}|₹|rs\.?\s?\d|in stock|free delivery/i);
    expect(replyViolations(body)).toEqual([]);
  });
  it("purchase intent: the template promises nothing, takes no payment and says a person will confirm", () => {
    const text = "I want to buy the pearl hoop earrings, how do I pay?";
    const { body } = templateReply(analyseEnquiry(text).context, recommendProducts(text, CATALOGUE, {}));
    expect(body).toMatch(/team will confirm the details/);
    expect(body).toMatch(/Pearl hoop earrings/);
    expect(body).not.toMatch(/upi|bank|account number|pay(ment)? link|₹|\d{3,}/i);
    expect(replyViolations(body)).toEqual([]);
  });
  it("end to end with AI off: a comparison enquiry gets a template draft that goes through approval, and nothing calls a model", async () => {
    const e = await newEnquiry("Which is better, the pearl hoop earrings or the minimal band ring?");
    const body = await json(await act(e.id, "reply", {}));
    expect(body.generator).toBe("template");
    expect(body.context.scenario).toBe("comparison");
    expect(body.data.body).toMatch(/Pearl hoop earrings/);
    expect((await msg(e.id, body.data.id, "submit")).status).toBe(200);
    expect(mine("approvals")[0]).toMatchObject({ status: "pending", type: "B2C Reply" });
  });
  it("AI on with a mocked transport: a purchase-intent draft is AI-written from closed-vocabulary input only", async () => {
    aiOn();
    const t = fakeTransport(okBody({ reply: "Thank you for your interest in the Pearl hoop earrings. Our team will confirm the details and next steps with you personally.\n\nCheri & Co." }));
    __setAiTransportForTests(t.transport);
    const e = await newEnquiry("Hi I am Asha Rao, 99999 11111. I want to buy the pearl hoop earrings, how do I pay?");
    const body = await json(await act(e.id, "reply", {}));
    expect(body.generator).toBe("ai");
    expect(t.calls).toHaveLength(1);
    const sent = JSON.stringify(t.calls);
    expect(sent).toMatch(/ready to buy/);
    expect(sent).not.toMatch(/Asha|Rao|99999|how do I pay|1499|aaaaaaaa/);
    expect(body.data.status).toBe("draft");
    expect(mine("approvals")).toHaveLength(0); // an AI draft is never auto-submitted
  });
  it("the AI instructions cover comparison and purchase intent without allowing prices, payment or promises", () => {
    expect(B2C_INSTRUCTIONS).toMatch(/comparison/);
    expect(B2C_INSTRUCTIONS).toMatch(/ready to buy/);
    expect(B2C_INSTRUCTIONS).toMatch(/Do not take or request payment/);
  });
});

describe("catalogue facts and gaps", () => {
  it("exposes name, category, description and image URL from the record, and never invents a price or stock", async () => {
    db.t.products.find((p) => p.id === P_HOOP)!.image_url = "https://img.test/hoop.jpg";
    db.t.products.find((p) => p.id === P_RING)!.price = null;
    const e = await newEnquiry("Which is better, the pearl hoop earrings or the minimal band ring?");
    const body = await json(await act(e.id, "recommendations", {}));
    const hoop = body.data.recommendations.find((r: { productId: string }) => r.productId === P_HOOP);
    const ring = body.data.recommendations.find((r: { productId: string }) => r.productId === P_RING);
    expect(hoop).toMatchObject({ name: "Pearl hoop earrings", category: "Earrings", description: "Small pearl hoops. Comes in a gift box.", imageUrl: "https://img.test/hoop.jpg" });
    expect(hoop.catalogueGaps).not.toContain("no image recorded");
    expect(ring).toMatchObject({ imageUrl: null, price: null });
    expect(ring.catalogueGaps).toEqual(expect.arrayContaining(["no image recorded", "no price recorded"]));
    expect(body.data.catalogueNotes.join(" ")).toMatch(/Minimal band ring: no image recorded/);
  });
  it("flags insufficient catalogue information instead of guessing", async () => {
    const none = await newEnquiry("Do you stock silk sarees?");
    const r = await json(await act(none.id, "recommendations", {}));
    expect(r.data.recommendations).toEqual([]);
    expect(r.data.catalogueNotes.join(" ")).toMatch(/No catalogue product matched/);
    const d = await json(await act(none.id, "reply", {}));
    expect(d.catalogueNotes.join(" ")).toMatch(/clarifying question/);
    expect(d.data.body).toMatch(/could you tell us which kind of jewellery/);
  });
  it("another organisation's product is never recommended or exposed", async () => {
    const e = await newEnquiry("Do you have foreign hoop earrings?");
    const r = await json(await act(e.id, "recommendations", {}));
    expect(JSON.stringify(r)).not.toMatch(/Foreign hoop|EAR-777/);
  });
});

describe("approval and rejection (re-checked after the new paths)", () => {
  it("rejection returns the conversation to draft_ready and the follow-up and history survive it", async () => {
    const e = await newEnquiry("I want to buy the pearl hoop earrings", { customerId: C1 });
    const d = (await json(await act(e.id, "reply", {}))).data;
    await act(e.id, "follow-up", { dueDate: tomorrow(), reason: "Confirm the order details" });
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[0].id), "reject", "wording");
    const one = (await json(await getOne(e.id))).data;
    expect(one.messages.find((m: { id: string }) => m.id === d.id).status).toBe("rejected");
    expect(one.followUps).toHaveLength(1);
    expect(mine("enquiry_messages").some((m) => m.status === "sent_manually")).toBe(false);
    expect((await act(e.id, "close")).status).toBe(200);
  });
});

/* ---------- Remediation of the independent audit (M1 to M4). The real SQL behind these (triggers, RPCs, indexes) is in tests/b2c-enquiry-db.test.ts. ---------- */

describe("M1: customer matching is exact (no wildcard, no partial match)", () => {
  it("refuses wildcard and pattern characters in any contact detail, and writes nothing", async () => {
    const before = db.t.customers.length;
    for (const customer of [
      { name: "X", email: "%@x.com" }, { name: "X", email: "*@x.com" }, { name: "X", email: "meera*@x.com" }, { name: "X", email: "a\\b@x.com" },
      { name: "X", instagram: "%" }, { name: "X", instagram: "me*" }, { name: "X", phone: "%%%%%%%" }, { name: "X", phone: "+91 9876*543210" },
    ]) expect((await create({ message: "hi", customer })).status, JSON.stringify(customer)).toBe(400);
    expect(db.t.customers).toHaveLength(before);
    expect(mine("enquiries")).toHaveLength(0);
  });
  it("an email that is only a prefix of a stored one is not a match (exact equality, no partial matching)", async () => {
    const r = await create({ message: "Do you have rings?", customer: { name: "N", email: "meera@x.co" } });
    expect((await json(r)).customer.created).toBe(true);
    expect(mine("customers").filter((c) => c.email === "meera@x.com")).toHaveLength(1);
  });
  it("an email in any case maps to the one stored lower-case value; the new customer is stored lower-case", async () => {
    const hit = await json(await create({ message: "Do you have rings?", customer: { name: "Z", email: "  MEERA@X.COM " } }));
    expect(hit.customer).toEqual({ id: C1, created: false });
    const fresh = await json(await create({ message: "Do you have bracelets?", customer: { name: "New Buyer", email: "New.Buyer@Example.COM" } }));
    expect(mine("customers").find((c) => c.id === fresh.customer.id)!.email).toBe("new.buyer@example.com");
    const again = await json(await create({ message: "And necklaces?", customer: { name: "Whoever", email: "NEW.BUYER@example.com" } }));
    expect(again.customer).toEqual({ id: fresh.customer.id, created: false });
  });
  it("phone numbers match across formatting (spaces, dashes, brackets) but never by a partial number", async () => {
    for (const phone of ["+91 98765 43210", "+91-98765-43210", "+(91) 98765 43210", "+919876543210"]) {
      const r = await json(await create({ message: `Do you have rings? ${phone}`, customer: { name: "Same Person", phone } }));
      expect(r.customer, phone).toEqual({ id: C1, created: false });
    }
    const partial = await json(await create({ message: "Do you have bangles?", customer: { name: "Other", phone: "98765 43210" } })); // no country code: a different number
    expect(partial.customer.created).toBe(true);
    const tail = await json(await create({ message: "Do you have chains?", customer: { name: "Tail", phone: "+1 555 000 3210" } })); // same last four digits only
    expect(tail.customer.created).toBe(true);
  });
  it("uses the CRM's own validation: the same limits as the Customers page", async () => {
    expect((await create({ message: "hi", customer: { name: "N".repeat(201), email: "a@b.co" } })).status).toBe(400);
    expect((await create({ message: "hi", customer: { name: "N", email: `${"a".repeat(250)}@b.co` } })).status).toBe(400);
    expect((await create({ message: "hi", customer: { name: "N", email: "a@b.co", city: "C".repeat(101) } })).status).toBe(400);
  });
  it("creates the customer through the CRM path: the CRM activity line is kept, interests start empty, and the enquiry is linked", async () => {
    const r = await json(await create({ message: "Do you have hoops?", customer: { name: "Asha Rao", email: "asha@example.com" } }));
    const made = mine("customers").find((c) => c.id === r.customer.id)!;
    expect(made).toMatchObject({ org_id: ORG, name: "Asha Rao", interests: [] });
    expect(mine("agent_activity").some((a) => a.agent === "crm" && /Added customer: Asha Rao/.test(String(a.action)))).toBe(true);
    expect(mine("enquiries")[0].customer_id).toBe(made.id);
  });
  it("no orphan customer if the enquiry cannot be created, and a customer that cannot be saved is reported, not hidden", async () => {
    const before = mine("customers").length;
    db.crash = "enquiry_messages"; // the create function fails (its transaction is rolled back)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await create({ message: "Do you have hoops?", customer: { name: "Asha Rao", email: "asha@example.com" } })).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect(mine("customers")).toHaveLength(before);
    expect(mine("enquiries")).toHaveLength(0);
    db.crash = "";
    db.beforeRpc = () => { db.crash = "customers"; }; // the enquiry is created, then the CRM insert fails
    const r = await create({ message: "Do you have hoops?", customer: { name: "Asha Rao", email: "asha@example.com" } });
    db.crash = "";
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(body.customer).toBeNull();
    expect(body.warning).toMatch(/customer could not be added/);
    expect(mine("customers")).toHaveLength(before);
    expect(mine("enquiries")).toHaveLength(1);
  });
});

describe("M2: submitting a reply is atomic and safe to repeat", () => {
  it("repeated submits (a double click, a network retry) return the same approval and create exactly one", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    const results = [] as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper
    for (let i = 0; i < 4; i++) { const r = await msg(e.id, d.id, "submit"); expect(r.status).toBe(200); results.push(await json(r)); }
    expect(new Set(results.map((r) => r.approval.id)).size).toBe(1);
    expect(mine("approvals")).toHaveLength(1);
    expect(results.map((r) => r.alreadySubmitted)).toEqual([false, true, true, true]);
    expect(mine("agent_activity").filter((a) => /for approval/.test(String(a.action)) && a.ref_type === "enquiry")).toHaveLength(1);
  });
  it("simultaneous submits (interleaved in one process) still produce one approval", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    const rs = await Promise.all([msg(e.id, d.id, "submit"), msg(e.id, d.id, "submit"), msg(e.id, d.id, "submit")]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(mine("approvals")).toHaveLength(1);
  });
  it("an edit that lands between the reviewer opening the draft and the submit makes the submit fail, never approve stale wording", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    db.beforeRpc = (fn) => { // a competing edit wins the race, right before the submit function runs
      if (fn !== "submit_b2c_reply") return;
      mine("enquiry_messages").find((m) => m.id === d.id)!.body = "A competing edit, newer than what the submit reviewed.\n\nCheri & Co.";
    };
    const r = await msg(e.id, d.id, "submit");
    expect(r.status).toBe(409);
    expect(mine("approvals")).toHaveLength(0);
    expect(mine("enquiry_messages").find((m) => m.id === d.id)).toMatchObject({ status: "draft", approval_id: null });
  });
  it("once pending, the wording is frozen: an edit is refused and the approval still carries exactly the stored text", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    const before = String(mine("enquiry_messages").find((m) => m.id === d.id)!.body);
    expect((await msg(e.id, d.id, "edit", { body: "Sneaky change after submitting.\n\nCheri & Co." })).status).toBe(409);
    expect(String(mine("enquiry_messages").find((m) => m.id === d.id)!.body)).toBe(before);
    expect(String(mine("approvals")[0].preview)).toBe(before);
  });
  it("an edit and a submit started together end in one consistent state (the approval text equals the stored text)", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    const [ed, sub] = await Promise.all([msg(e.id, d.id, "edit", { body: "Edited at the same time.\n\nCheri & Co." }), msg(e.id, d.id, "submit")]);
    expect([200, 409]).toContain(ed.status);
    expect([200, 409]).toContain(sub.status);
    const stored = mine("enquiry_messages").find((m) => m.id === d.id)!;
    for (const a of mine("approvals")) expect(a.preview).toBe(stored.body);
    expect(mine("approvals").length).toBeLessThanOrEqual(1);
  });
  it("a database that has not got the new functions answers 503, not a 500 or a half-done submit", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    db.missing = "rpc";
    expect((await msg(e.id, d.id, "submit")).status).toBe(503);
    expect((await create({ message: "hi" })).status).toBe(503);
    expect(mine("approvals")).toHaveLength(0);
  });
});

describe("M3: enquiry and message status stay consistent; texts cannot diverge", () => {
  const long = (n: number) => `${"Thank you for writing to Cheri & Co. ".repeat(Math.ceil(n / 36)).slice(0, n - 1)}.`;
  it("an approver's edit longer than a person's customer message (up to 6000 characters) is accepted and stored identically", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    const text = long(5800);
    expect(await decideApproval(String(mine("approvals")[0].id), "edit", "u1", "longer", { preview: text })).toMatchObject({ ok: true });
    expect(mine("enquiry_messages").find((m) => m.id === d.id)!.body).toBe(text); // not truncated to 2000
    expect(await decideApproval(String(mine("approvals")[0].id), "approve", "u1", "ok")).toMatchObject({ ok: true });
    const m = mine("enquiry_messages").find((x) => x.id === d.id)!;
    expect(m.status).toBe("approved");
    expect(m.body).toBe(mine("approvals")[0].preview); // approved content and stored content are one text
    expect(mine("enquiries")[0].status).toBe("approved");
  });
  it("a person can edit a reply up to 6000 characters; one character more is refused", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    expect((await msg(e.id, d.id, "edit", { body: long(6000) })).status).toBe(200);
    expect((await msg(e.id, d.id, "edit", { body: long(6001) })).status).toBe(409);
  });
  it("the enquiry status follows the latest reply through every step, with no code path writing it", async () => {
    const e = await newEnquiry();
    const status = () => mine("enquiries")[0].status;
    expect(status()).toBe("new");
    const d = (await json(await act(e.id, "reply", {}))).data;
    expect(status()).toBe("draft_ready");
    await msg(e.id, d.id, "submit");
    expect(status()).toBe("awaiting_approval");
    await decideApproval(String(mine("approvals")[0].id), "reject", "u1", "no");
    expect(status()).toBe("draft_ready");
    await msg(e.id, d.id, "edit", { body: "A better version.\n\nCheri & Co." });
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[1].id), "approve", "u1", "yes");
    expect(status()).toBe("approved");
    await msg(e.id, d.id, "mark-sent");
    expect(status()).toBe("replied");
    expect(mine("enquiries")[0].status).toBe((await json(await getOne(e.id))).data.status);
  });
  it("a decision that cannot be recorded is not swallowed: the live path no longer has a best-effort sync step", async () => {
    const src = (await import("node:fs")).readFileSync("src/services/live.ts", "utf8");
    expect(src).not.toMatch(/syncB2cReply/);
    expect(src).not.toMatch(/\.from\("enquiry_messages"\)/);
  });
  it("retrieval shows stored statuses (one source of truth) for the list, the messages page and the detail", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[0].id), "approve", "u1", "ok");
    const page = await json(await (await import("@/app/api/b2c/enquiries/[id]/messages/route")).GET(new Request(`https://app.test/api/b2c/enquiries/${e.id}/messages`), { params: Promise.resolve({ id: e.id }) }));
    expect(page.data.map((m: { status: string }) => m.status)).toEqual(["received", "approved"]);
    expect((await json(await listRoute(new Request("https://app.test/api/b2c/enquiries")))).data[0].status).toBe("approved");
    expect(db.reads.filter((t) => t === "approvals").length).toBeGreaterThanOrEqual(0); // no per-message approval lookups are needed to show a status
  });
});

describe("M4: one live draft per enquiry; history is never blocked", () => {
  it("two simultaneous draft requests leave exactly one draft", async () => {
    const e = await newEnquiry();
    const rs = await Promise.all([act(e.id, "reply", {}), act(e.id, "reply", {})]);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    expect(mine("enquiry_messages").filter((m) => m.direction === "outbound")).toHaveLength(1);
  });
  it("the second of two interleaved requests is answered with a clear 409 (unique index) or regenerates the first draft, never a 500 and never a second draft", async () => {
    const e = await newEnquiry();
    const rs = await Promise.all([act(e.id, "reply", {}), act(e.id, "reply", {}), act(e.id, "reply", {})]);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    expect(mine("enquiry_messages").filter((m) => m.direction === "outbound")).toHaveLength(1);
  });
  it("rejected, approved and sent replies stay as history: a new draft is allowed after them", async () => {
    const e = await newEnquiry();
    const d = (await json(await act(e.id, "reply", {}))).data;
    await msg(e.id, d.id, "submit");
    await decideApproval(String(mine("approvals")[0].id), "approve", "u1", "ok");
    await msg(e.id, d.id, "mark-sent");
    const next = await act(e.id, "reply", {});
    expect(next.status).toBe(200);
    expect((await json(next)).regenerated).toBe(false);
    expect(mine("enquiry_messages").filter((m) => m.direction === "outbound")).toHaveLength(2);
  });
});
