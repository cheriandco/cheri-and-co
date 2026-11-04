/** Live data slice: tasks, approvals, audit log and agent activity read and written through the user's own Supabase
 *  session. The Supabase client is a recording fake, so these tests prove the application logic (org scoping, mapping,
 *  no mixing with sample data, error handling). They do NOT prove the real database: see docs/rls_live_check.sql. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
interface Call { table: string; op: string; eq: Row; payload?: Row; range?: [number, number] }
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as { table: string; op: string; eq: Record<string, unknown>; payload?: Record<string, unknown>; range?: [number, number] }[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: { data: null, error: null } as { data: unknown; error: { code?: string; message: string } | null },
  /** A result (or a function that also changes the fake tables) for one named database function. */
  rpcByFn: {} as Record<string, { data: unknown; error: { code?: string; message: string } | null } | ((args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null })>,
  insertError: null as { code?: string; message: string } | null,
  /** Makes a matching update fail with an error, or match no rows when it returns "empty". */
  /** Emulates the API's max-rows setting (1000 by default): no response carries more rows than this, whatever the query asks for. */
  maxRows: 1000,
  updateFault: null as null | ((table: string, payload: Record<string, unknown>) => { code?: string; message: string } | "empty" | null),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => { h.rpcCalls.push({ fn, args }); const r = h.rpcByFn[fn]; return typeof r === "function" ? r(args) : (r ?? h.rpcResult); },
    from: (table: string) => {
      const call: Call = { table, op: "select", eq: {} };
      h.calls.push(call);
      let single = false;
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (payload: Row) => { call.op = "insert"; call.payload = payload; return q; },
        update: (payload: Row) => { call.op = "update"; call.payload = payload; return q; },
        eq: (k: string, v: unknown) => { call.eq[k] = v; return q; },
        // .not() and .gte() are recorded as "not:col" / "gte:col" and applied below, so the tests can see the filters
        not: (k: string, op: string, v: unknown) => { call.eq[`not:${k}`] = `${op} ${String(v)}`; return q; },
        gte: (k: string, v: unknown) => { call.eq[`gte:${k}`] = v; return q; },
        in: () => q, order: () => q, limit: () => q,
        range: (a: number, b: number) => { call.range = [a, b]; return q; },
        single: () => { single = true; return q; },
        maybeSingle: () => { single = true; return q; },
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          if (call.op === "insert" && h.insertError) return resolve({ data: null, error: h.insertError });
          const fault = call.op === "update" ? h.updateFault?.(table, call.payload ?? {}) : null;
          if (fault === "empty") return resolve({ data: single ? null : [], error: null });
          if (fault) return resolve({ data: null, error: fault });
          const all = h.tables[table] ?? [];
          const rows = call.op === "insert" ? [{ id: "new-1", source: "Manual", status: "open", assignee_id: null, ...call.payload }]
            : all.filter((r) => Object.entries(call.eq).every(([k, v]) => {
              if (k.startsWith("gte:")) return String(r[k.slice(4)]) >= String(v);
              if (!k.startsWith("not:")) return r[k] === v;
              const col = k.slice(4), [op, arg] = String(v).split(/ (.*)/s);
              return op === "is" ? r[col] !== null && r[col] !== undefined : !arg.slice(1, -1).split(",").includes(String(r[col]));
            })).map((r) => (call.op === "update" ? { ...r, ...call.payload } : r));
          const paged = (call.range ? rows.slice(call.range[0], call.range[1] + 1) : rows).slice(0, h.maxRows);
          resolve({ data: single ? (rows[0] ?? null) : paged, error: null });
        },
      };
      return q;
    },
  }),
}));

import { AuthError } from "@/lib/auth/access";
import {
  createTask, decideApproval, getActivities, getAgents, getAmazon, getApprovals, getAuditLog, getConversations, getCustomers,
  getDashboardSummary, getNotifications, getOrchestratorBrief, getReports, getRetailers, getSearchIndex, getTasks, updateTask,
} from "@/services";
import { writableStore } from "@/services/store";
import { ago, dueLabel, parseDue, toApproval, toTask } from "@/services/live-map";

const ORG = "11111111-1111-4111-8111-111111111111";
const setMembership = (isDemo: boolean) => { h.tables.memberships = [{ user_id: "u1", org_id: ORG, role: "owner", organizations: { is_demo: isDemo } }]; };

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "required");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  h.calls.length = 0; h.rpcCalls.length = 0; h.insertError = null; h.updateFault = null; h.maxRows = 1000;
  h.rpcResult = { data: null, error: null }; h.rpcByFn = {};
  h.tables = {
    tasks: [{ id: "t1", org_id: ORG, title: "Call Asha", source: "CRM & Sales Ops Agent", due_at: null, priority: "high", status: "open", assignee_id: null, related_ref: null },
            { id: "t2", org_id: "other-org", title: "Not mine", source: "Manual", due_at: null, priority: "low", status: "open", assignee_id: null, related_ref: null }],
    approvals: [{ id: "a1", org_id: ORG, title: "Reply to Meera", type: "Instagram reply", generated_by: "b2c", status: "pending", preview: "Hi", meta: null, created_at: new Date().toISOString() }],
    audit_log: [{ id: 1, org_id: ORG, approval_id: "a0", action: "approve", actor_id: "u1", note: null, at: new Date().toISOString() }],
    agent_activity: [{ id: 1, org_id: ORG, agent: "crm", action: "Created task: Call Asha", ref_id: null, actor_id: "u1", created_at: new Date().toISOString() }],
    profiles: [{ id: "u1", display_name: "Priya" }],
  };
  setMembership(false);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("live organisation reads its own database rows", () => {
  it("returns only this organisation's tasks, mapped to the app's types", async () => {
    const tasks = await getTasks();
    expect(tasks.map((t) => t.title)).toEqual(["Call Asha"]);
    expect(tasks[0]).toMatchObject({ id: "t1", priority: "high", due: "Unscheduled", assignee: "Unassigned", status: "open", href: "/tasks" });
  });
  it("scopes every query by the organisation from the verified session", async () => {
    await Promise.all([getTasks(), getApprovals(), getAuditLog(), getActivities()]);
    const business = h.calls.filter((c) => ["tasks", "approvals", "audit_log", "agent_activity"].includes(c.table));
    expect(business.length).toBeGreaterThanOrEqual(4);
    for (const c of business) expect(c.eq.org_id, c.table).toBe(ORG);
  });
  it("maps approvals, audit entries (actor names) and activity", async () => {
    expect((await getApprovals())[0]).toMatchObject({ id: "a1", type: "Instagram reply", generatedBy: "b2c", status: "pending", created: "Just now" });
    expect((await getAuditLog())[0]).toMatchObject({ approvalId: "a0", action: "approve", actor: "Priya" });
    expect((await getActivities())[0]).toMatchObject({ actor: "Priya", agent: "crm", text: "Created task: Call Asha" });
  });
});

describe("sample data never reaches a live organisation", () => {
  it("every sample-backed read is empty", async () => {
    expect(await getAgents()).toEqual([]);
    expect(await getCustomers()).toEqual([]);
    expect(await getConversations()).toEqual([]);
    expect(await getRetailers()).toEqual([]); // empty because this organisation has none, never the sample retailers
    expect(await getNotifications()).toEqual([]);
    expect(await getSearchIndex()).toEqual([]);
    expect((await getReports()).map((r) => r.id)).toEqual(["sales"]); // only Sales, computed from this organisation's delivered orders; no sample sections
    expect((await getAmazon()).rows).toEqual([]);
  });
  it("the dashboard and the orchestrator show only live counts and 'not connected' for the rest", async () => {
    const d = await getDashboardSummary();
    expect(d.kpis).toEqual([]); expect(d.retailers).toEqual([]); expect(d.enquiries).toEqual([]);
    expect(d.approvals.map((a) => a.id)).toEqual(["a1"]);
    expect(d.tasks.map((t) => t.id)).toEqual(["t1"]);
    const b = await getOrchestratorBrief();
    expect(b.totals).toEqual({ pending: 1, openTasks: 1, hotLeads: 0 });
    expect(b.agents.find((a) => a.key === "b2b")!.headline).toMatch(/0 hot leads, 0 retailers/);
    expect(b.agents.find((a) => a.key === "b2c")!.headline).toMatch(/Not connected/);
    expect(JSON.stringify(b)).not.toMatch(/SAMPLE|Aurelia|Moonlit/);
  });
  it("writes that are not connected yet fail instead of touching the sample store", async () => {
    await expect(writableStore()).rejects.toThrow(/not connected/);
  });
  it("a demo organisation still gets the sample data", async () => {
    setMembership(true);
    expect((await getRetailers()).length).toBeGreaterThan(0);
    expect((await getAgents()).length).toBe(5);
  });
});

describe("sample-backed API generators", () => {
  const post = (url: string, body: unknown) => new Request(`https://app.test${url}`, { method: "POST", headers: { "content-type": "application/json", host: "app.test" }, body: JSON.stringify(body) });
  it("the B2C drafting API refuses a live organisation (it would quote the sample catalogue)", async () => {
    const { POST } = await import("@/app/api/agents/b2c/run/route");
    expect((await POST(post("/api/agents/b2c/run", { enquiry: "Do you have silver earrings?" }))).status).toBe(501);
    setMembership(true);
    expect((await POST(post("/api/agents/b2c/run", { enquiry: "Do you have silver earrings?" }))).status).toBe(200);
  });
  it("the content API finds no sample products for a live organisation", async () => {
    const { POST } = await import("@/app/api/agents/content/run/route");
    const body = { targetType: "product", targetId: "SAMPLE-P-001" };
    expect((await POST(post("/api/agents/content/run", body))).status).toBeGreaterThanOrEqual(400);
    setMembership(true);
    expect((await POST(post("/api/agents/content/run", body))).status).toBe(200); // same request works for the demo organisation
  });
});

describe("live writes", () => {
  it("creates a task in the signed-in user's organisation, ignoring any organisation in the input", async () => {
    const t = await createTask({ title: "Ring the retailer", due: "Today", priority: "high", assignee: "Anika", ...({ org_id: "evil-org" } as object) });
    expect(t).toMatchObject({ title: "Ring the retailer", priority: "high", due: "Today" });
    const ins = h.calls.find((c) => c.table === "tasks" && c.op === "insert")!;
    expect(ins.payload!.org_id).toBe(ORG);
    expect(ins.payload!.due_at).toEqual(expect.any(String));
    expect(h.calls.some((c) => c.table === "agent_activity" && c.op === "insert")).toBe(true);
  });
  it("a refused write becomes a 403, not a crash", async () => {
    h.insertError = { code: "42501", message: "new row violates row-level security policy" };
    await expect(createTask({ title: "x", due: "Today", priority: "low", assignee: "A" })).rejects.toMatchObject({ status: 403 });
  });
  it("updates a task only inside the organisation", async () => {
    const t = await updateTask("t1", { status: "done" });
    expect(t?.status).toBe("done");
    const upd = h.calls.find((c) => c.op === "update")!;
    expect(upd.eq).toMatchObject({ org_id: ORG, id: "t1" });
    expect(await updateTask("t2", { status: "done" })).toBeNull(); // another organisation's id matches nothing
  });
});

describe("live approval decisions", () => {
  const approved = { id: "a1", title: "Reply to Meera", type: "Instagram reply", generated_by: "b2c", status: "approved", preview: "Hi", meta: null, created_at: new Date().toISOString() };
  it("calls decide_approval so the database checks the role and writes the audit row", async () => {
    h.rpcResult = { data: approved, error: null };
    const res = await decideApproval("a1", "approve", "ignored-client-name", "ok");
    expect(res).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(h.rpcCalls[0]).toEqual({ fn: "decide_approval", args: { p_id: "a1", p_action: "approve", p_note: "ok", p_title: null, p_preview: null } });
    expect(JSON.stringify(h.rpcCalls)).not.toContain("ignored-client-name"); // the actor is never taken from the request
  });
  it("maps database errors", async () => {
    h.rpcResult = { data: null, error: { code: "P0002", message: "not found" } };
    expect(await decideApproval("a1", "approve", "x")).toEqual({ ok: false, reason: "not_found" });
    h.rpcResult = { data: null, error: { code: "P0001", message: "already decided" } };
    expect(await decideApproval("a1", "approve", "x")).toEqual({ ok: false, reason: "not_pending" });
    h.rpcResult = { data: null, error: { code: "42501", message: "not authorized" } };
    await expect(decideApproval("a1", "approve", "x")).rejects.toBeInstanceOf(AuthError);
  });
  it("the content claim guard still blocks a bad draft before the database is called", async () => {
    h.tables.approvals = [{ id: "a9", org_id: ORG, title: "Post", type: "Content", generated_by: "content", status: "pending",
      preview: "Pure 18k gold, 50% off today!", meta: { kind: "content_draft", subject: "x", isSample: false, allowedClaims: [] }, created_at: new Date().toISOString() }];
    const res = await decideApproval("a9", "approve", "x");
    expect(res).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(h.rpcCalls).toEqual([]);
  });
  it("a list of allowed claims stored in the approval's metadata is ignored (users can write it), so it unlocks nothing", async () => {
    h.tables.approvals = [{ id: "a9", org_id: ORG, title: "Post", type: "Content", generated_by: "content", status: "pending",
      preview: "Waterproof and anti-tarnish", meta: { kind: "content_draft", allowedClaims: ["waterproof", "anti-tarnish"] }, created_at: new Date().toISOString() }];
    expect(await decideApproval("a9", "approve", "x")).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(h.rpcCalls).toEqual([]);
  });
  it("a content approval is checked even when its metadata does not say so (type or generator is enough)", async () => {
    h.tables.approvals = [{ id: "a9", org_id: ORG, title: "Post", type: "Content", generated_by: "content", status: "pending", preview: "Only ₹499", meta: null, created_at: new Date().toISOString() }];
    expect(await decideApproval("a9", "approve", "x")).toMatchObject({ ok: false, reason: "prohibited_claims" });
  });
  it("a refusal from the database (a direct or racing call) is reported as prohibited claims with its details, not as a crash", async () => {
    h.rpcResult = { data: null, error: { code: "23514", message: 'prohibited claims: price: "₹499" | discount or offer: "sale"' } };
    expect(await decideApproval("a1", "approve", "x")).toEqual({ ok: false, reason: "prohibited_claims", detail: ['price: "₹499"', 'discount or offer: "sale"'] });
  });
  it("F4: editing the approval of a post is refused by the database and reported as a conflict with a plain message, not as a crash", async () => {
    h.rpcResult = { data: null, error: { code: "P0001", message: "a content approval cannot be edited; reject it and change the post instead" } };
    expect(await decideApproval("a1", "edit", "x", undefined, { preview: "new text" })).toEqual({ ok: false, reason: "not_editable" });
    const res = await (await import("@/app/api/approvals/[id]/[action]/route")).POST(
      new Request("https://app.test/api/approvals/a1/edit", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.test" }, body: JSON.stringify({ preview: "new text" }) }),
      { params: Promise.resolve({ id: "a1", action: "edit" }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot be edited/);
  });
  it("F6: the approval's title is scanned by the early check as well", async () => {
    h.tables.approvals = [{ id: "a9", org_id: ORG, title: "Real gold sale", type: "Content", generated_by: "content", status: "pending", preview: "Caption: a calm look", meta: null, created_at: new Date().toISOString() }];
    expect(await decideApproval("a9", "approve", "x")).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(h.rpcCalls).toEqual([]);
  });
  it("F1: a look-alike spelling is caught by the early check too (no-break space in a price, zero-width character in a claim)", async () => {
    const nbsp = String.fromCodePoint(0xa0);
    const zwsp = String.fromCodePoint(0x200b);
    for (const preview of [`Only ₹${nbsp}499`, `water${zwsp}proof`]) {
      h.tables.approvals = [{ id: "a9", org_id: ORG, title: "Post", type: "Content", generated_by: "content", status: "pending", preview, meta: null, created_at: new Date().toISOString() }];
      expect(await decideApproval("a9", "approve", "x"), preview).toMatchObject({ ok: false, reason: "prohibited_claims" });
    }
  });
  it("non-content approvals with a price in them are not blocked by the early check", async () => {
    h.rpcResult = { data: { id: "a1", title: "Reply", type: "Instagram reply", generated_by: "b2c", status: "approved", preview: "It is ₹499", meta: null, created_at: new Date().toISOString() }, error: null };
    h.tables.approvals = [{ id: "a1", org_id: ORG, title: "Reply", type: "Instagram reply", generated_by: "b2c", status: "pending", preview: "It is ₹499, 50% off", meta: null, created_at: new Date().toISOString() }];
    expect(await decideApproval("a1", "approve", "x")).toMatchObject({ ok: true });
  });
});

describe("mapping helpers", () => {
  const now = new Date("2026-11-04T10:00:00");
  it("formats due dates and relative times", () => {
    expect(dueLabel(null, now)).toBe("Unscheduled");
    expect(dueLabel(new Date("2026-11-04T17:00:00").toISOString(), now)).toBe("Today");
    expect(dueLabel(new Date("2026-11-05T17:00:00").toISOString(), now)).toBe("Tomorrow");
    expect(ago(new Date(now.getTime() - 5 * 60000).toISOString(), now)).toBe("5 min ago");
    expect(ago(new Date(now.getTime() - 3 * 3600000).toISOString(), now)).toBe("3 h ago");
  });
  it("parses the due text people type", () => {
    expect(parseDue("Unscheduled", now)).toBeNull();
    expect(parseDue("garbage text", now)).toBeNull();
    expect(dueLabel(parseDue("Today", now), now)).toBe("Today");
    expect(dueLabel(parseDue("Tomorrow", now), now)).toBe("Tomorrow");
    expect(parseDue("2026-12-01", now)).toMatch(/^2026-12-0/);
  });
  it("falls back safely on unexpected values", () => {
    expect(toTask({ id: "x", title: "t", source: "s", due_at: null, priority: "weird", status: "odd", assignee_id: null, related_ref: null }, new Map()))
      .toMatchObject({ priority: "medium", status: "open" });
    expect(toApproval({ id: "a", title: "t", type: "Content", generated_by: "nobody", status: "pending", preview: "p", meta: null, created_at: now.toISOString() }, now).generatedBy).toBe("crm");
  });
});

/* ---------- Slice 2: customers, retailers, leads (fake client: proves app logic, not the real database) ---------- */
import { POST as postResource } from "@/app/api/[resource]/route";
import { createCustomer, createRetailer, getCustomer, moveDeal } from "@/services";
import { parseCustomerInput, parseRetailerInput } from "@/lib/validate";
import { mapsSearchUrl, toCustomer, toDeal, toRetailer } from "@/services/live-map";

const C1 = "22222222-2222-4222-8222-222222222222";
const C_OTHER = "55555555-5555-4555-8555-555555555555";
const R1 = "33333333-3333-4333-8333-333333333333";
const L1 = "44444444-4444-4444-8444-444444444444";
const L_OTHER = "77777777-7777-4777-8777-777777777777";
const stamp = new Date().toISOString();
const blankRetailer = { location: null, category: null, contact: null, email: null, phone: null, instagram: null, website: null, qualification: null, created_at: stamp };
const seedPipeline = () => {
  h.tables.customers = [
    { id: C1, org_id: ORG, name: "Meera", instagram: "@meera", phone: null, email: null, city: "Pune", interests: ["saree"], created_at: stamp },
    { id: C_OTHER, org_id: "other-org", name: "Not mine", instagram: null, phone: null, email: null, city: null, interests: null, created_at: stamp },
  ];
  h.tables.orders = [{ customer_id: C1, org_id: ORG }, { customer_id: C1, org_id: ORG }];
  h.tables.retailers = [
    { id: R1, org_id: ORG, business: "Aurelia Boutique", ...blankRetailer, location: "Pune", category: "Boutique" },
    { id: "66666666-6666-4666-8666-666666666666", org_id: "other-org", business: "Other Org Shop", ...blankRetailer },
  ];
  h.tables.leads = [
    { id: L1, org_id: ORG, retailer_id: R1, stage: "negotiation", score: 82, temperature: "HOT", owner_id: "u1", last_activity_at: stamp },
    { id: L_OTHER, org_id: "other-org", retailer_id: R1, stage: "won", score: 1, temperature: "COLD", owner_id: null, last_activity_at: stamp },
  ];
};
const post = (resource: string, body: unknown) =>
  postResource(new Request(`https://app.test/api/${resource}`, {
    method: "POST", headers: { host: "app.test", origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ resource }) });

describe("slice 2: live customers, retailers and leads", () => {
  beforeEach(seedPipeline);

  it("reads only this organisation's customers, with purchases counted from orders", async () => {
    const list = await getCustomers();
    expect(list.map((c) => c.name)).toEqual(["Meera"]);
    expect(list[0]).toMatchObject({ purchases: 2, amazonClicks: 0, phone: "", interests: ["saree"] });
    expect((await getCustomer(C1))?.name).toBe("Meera");
    expect(await getCustomer(C_OTHER)).toBeNull();
    expect(await getCustomer("not-a-uuid")).toBeNull();
  });
  it("maps a retailer with its lead and never counts another organisation's lead", async () => {
    const [r] = await getRetailers();
    expect(r).toMatchObject({ id: R1, business: "Aurelia Boutique", score: 82, temperature: "HOT", stage: "negotiation", status: "Negotiation", email: "Not recorded" });
    expect(r.mapsUrl).toBe(mapsSearchUrl("Aurelia Boutique", "Pune"));
    const summary = await getDashboardSummary();
    expect(summary.funnel.find((f) => f.stage === "negotiation")?.count).toBe(1);
    expect(summary.funnel.find((f) => f.stage === "won")?.count).toBe(0);
  });
  it("scopes every slice 2 query by the organisation from the verified session", async () => {
    h.calls.length = 0;
    await Promise.all([getCustomers(), getRetailers(), getSearchIndex()]);
    const q = h.calls.filter((c) => ["customers", "retailers", "leads", "orders"].includes(c.table));
    expect(q.length).toBeGreaterThanOrEqual(4);
    for (const c of q) expect(c.eq.org_id, c.table).toBe(ORG);
  });
  it("search covers the organisation's own customers and retailers only", async () => {
    const labels = (await getSearchIndex()).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["Meera", "Aurelia Boutique"]));
    expect(labels).not.toContain("Other Org Shop");
  });
  it("creating a customer sends the session's organisation, ignoring any organisation in the body", async () => {
    h.calls.length = 0;
    const res = await post("customers", { name: "Asha", city: "Delhi", org_id: "attacker-org", interests: ["kurta"] });
    expect(res.status).toBe(201);
    const insert = h.calls.find((c) => c.table === "customers" && c.op === "insert")!;
    expect(insert.payload).toMatchObject({ org_id: ORG, name: "Asha", city: "Delhi" });
    expect(insert.payload).not.toHaveProperty("id");
  });
  it("creating a retailer also creates its first lead at stage new", async () => {
    h.calls.length = 0;
    const res = await post("retailers", { business: "Moonlit Studio", location: "Jaipur" });
    expect(res.status).toBe(201);
    expect(h.calls.find((c) => c.table === "retailers" && c.op === "insert")!.payload).toMatchObject({ org_id: ORG, business: "Moonlit Studio" });
    expect(h.calls.find((c) => c.table === "leads" && c.op === "insert")!.payload).toMatchObject({ org_id: ORG, stage: "new" });
  });
  it("rejects invalid input with 400 and writes nothing", async () => {
    h.calls.length = 0;
    expect((await post("customers", { name: "" })).status).toBe(400);
    expect((await post("retailers", {})).status).toBe(400);
    expect(h.calls.filter((c) => c.op === "insert")).toEqual([]);
  });
  it("moving a deal updates the lead stage inside the organisation only", async () => {
    h.calls.length = 0;
    expect((await moveDeal(L1, "won"))?.stage).toBe("won");
    const upd = h.calls.find((c) => c.table === "leads" && c.op === "update")!;
    expect(upd.eq).toMatchObject({ org_id: ORG, id: L1 });
    expect(await moveDeal(L_OTHER, "lost")).toBeNull();
    expect(await moveDeal("nope", "lost")).toBeNull();
  });
  it("a viewer cannot create records (403); a staff member can", async () => {
    h.tables.memberships = [{ user_id: "u1", org_id: ORG, role: "viewer", organizations: { is_demo: false } }];
    expect((await post("customers", { name: "Asha" })).status).toBe(403);
    expect((await post("retailers", { business: "X" })).status).toBe(403);
    h.tables.memberships = [{ user_id: "u1", org_id: ORG, role: "staff", organizations: { is_demo: false } }];
    expect((await post("customers", { name: "Asha" })).status).toBe(201);
  });
  it("a demo organisation cannot create records and sees sample data, not live rows", async () => {
    setMembership(true);
    expect(await createCustomer({ name: "Asha" } as never)).toBeNull();
    expect(await createRetailer({ business: "X" } as never)).toBeNull();
    expect((await getCustomers()).some((c) => c.name === "Meera")).toBe(false);
    expect((await getRetailers()).some((r) => r.business === "Aurelia Boutique" && r.id === R1)).toBe(false);
    expect((await getRetailers()).length).toBeGreaterThan(0);
  });
  it("a database failure is not reported as success", async () => {
    h.insertError = { message: "boom" };
    await expect(post("customers", { name: "Asha" })).rejects.toBeDefined();
  });
});

describe("slice 2: validation and mapping helpers", () => {
  it("parses customer and retailer input, blanking empty optionals and rejecting missing names", () => {
    expect(parseCustomerInput({ name: " Asha ", city: "" })).toMatchObject({ name: "Asha", city: null });
    expect(parseCustomerInput({ name: "" })).toBeNull();
    expect(parseCustomerInput(null)).toBeNull();
    expect(parseRetailerInput({ business: "Shop" })).toMatchObject({ business: "Shop" });
    expect(parseRetailerInput({ location: "Pune" })).toBeNull();
  });
  it("falls back safely for rows with missing data or an unknown stage", () => {
    const row = { id: "r", business: "B", ...blankRetailer };
    expect(toRetailer(row)).toMatchObject({ stage: "new", score: 0, temperature: "COLD", contact: "Not recorded" });
    expect(toCustomer({ id: "c", name: "N", instagram: null, phone: null, email: null, city: null, interests: null, created_at: stamp }, 0).interests).toEqual([]);
    const d = toDeal({ id: "l", retailer_id: "r", stage: "bogus", score: null, temperature: null, owner_id: null, last_activity_at: stamp }, row, new Map());
    expect(d).toMatchObject({ stage: "new", score: 0, owner: "Unassigned" });
  });
});

/* ---------- Slice 3: products and content items (fake client: proves app logic, not the real database) ---------- */
import { PATCH as patchResource } from "@/app/api/[resource]/[id]/route";
import { POST as postSocial } from "@/app/api/social/posts/route";
import { POST as postSocialAction } from "@/app/api/social/posts/[id]/[action]/route";
import { createProduct, getProduct, getProducts, getSocialPosts, updateProduct } from "@/services";
import { parseProductInput } from "@/lib/validate";
import { toProduct, toSocialPost } from "@/services/live-map";

const P1 = "88888888-8888-4888-8888-888888888888";
const P_OTHER = "99999999-9999-4999-8999-999999999999";
const POST1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POST_PENDING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POST_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APPROVAL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const json = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const jreq = (method: string, url: string, body?: unknown) => new Request(url, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
const postProduct = (body: unknown) => postResource(jreq("POST", "https://app.test/api/products", body), { params: Promise.resolve({ resource: "products" }) });
const patchProduct = (id: string, body: unknown) => patchResource(jreq("PATCH", `https://app.test/api/products/${id}`, body), { params: Promise.resolve({ resource: "products", id }) });
const postAction = (id: string, action: string, body?: unknown) => postSocialAction(jreq("POST", `https://app.test/api/social/posts/${id}/${action}`, body), { params: Promise.resolve({ id, action }) });
const setRole = (role: string) => { h.tables.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: false } }]; };

const productRow = (over: Row) => ({ id: P1, org_id: ORG, sku: "CC-001", name: "Mini hoop", category: "Earrings", price: "1499.00", stock: 12, status: "active", channels: ["Website"], created_at: stamp, ...over });
const contentRow = (over: Row) => ({
  id: POST1, org_id: ORG, platform: "Instagram", title: "Everyday stack", topic: "Layering", caption: "A calm everyday stack.", hashtags: ["#CheriAndCo"],
  creative_brief: "Soft light", image_direction: "Flat lay", scheduled_for: "2026-11-10", status: "draft", approval_id: null, created_at: stamp, ...over,
});
const seedCatalogue = () => {
  h.tables.products = [productRow({}), productRow({ id: P_OTHER, org_id: "other-org", name: "Not mine", sku: "X-1" })];
  h.tables.content_items = [
    contentRow({}),
    contentRow({ id: POST_PENDING, title: "Waiting", status: "pending_approval", approval_id: APPROVAL_ID }),
    contentRow({ id: POST_OTHER, org_id: "other-org", title: "Other org post" }),
  ];
  h.tables.approvals = [...(h.tables.approvals ?? []), { id: APPROVAL_ID, org_id: ORG, title: "Waiting · Instagram post", type: "Content", generated_by: "content", status: "approved", preview: "x", meta: { kind: "content_draft", postId: POST_PENDING }, created_at: stamp }];
};

describe("slice 3: live products", () => {
  beforeEach(seedCatalogue);

  it("lists only this organisation's products, mapped to the schema's columns", async () => {
    h.calls.length = 0;
    const list = await getProducts();
    expect(list.map((p) => p.name)).toEqual(["Mini hoop"]);
    expect(list[0]).toMatchObject({ sku: "CC-001", price: 1499, stock: 12, status: "active", channels: ["Website"] });
    expect(h.calls.filter((c) => c.table === "products").every((c) => c.eq.org_id === ORG)).toBe(true);
  });
  it("keeps an unset price and stock as null instead of inventing a number, and shows archived", () => {
    expect(toProduct(productRow({ price: null, stock: null, status: "archived", category: null, channels: null }) as never))
      .toMatchObject({ price: null, stock: null, status: "archived", category: "", channels: [] });
  });
  it("product detail finds own products only", async () => {
    expect((await getProduct(P1))?.sku).toBe("CC-001");
    expect(await getProduct(P_OTHER)).toBeNull();
    expect(await getProduct("not-a-uuid")).toBeNull();
  });
  it("search includes this organisation's products", async () => {
    const hit = (await getSearchIndex()).find((s) => s.label === "Mini hoop");
    expect(hit).toMatchObject({ hint: "Product", href: `/products/${P1}` });
    expect((await getSearchIndex()).some((s) => s.label === "Not mine")).toBe(false);
  });
  it("creates a product in the session's organisation with only the table's columns", async () => {
    h.calls.length = 0;
    const res = await postProduct({ sku: "CC-002", name: "Pearl drop", price: "2499.5", stock: "4", status: "active", channels: "Website, Amazon", org_id: "attacker-org", reach: 99 });
    expect(res.status).toBe(201);
    const ins = h.calls.find((c) => c.table === "products" && c.op === "insert")!;
    expect(ins.payload).toEqual({ org_id: ORG, sku: "CC-002", name: "Pearl drop", category: null, price: 2499.5, stock: 4, status: "active", channels: ["Website", "Amazon"] });
  });
  it("rejects invalid products with 400 and writes nothing", async () => {
    h.calls.length = 0;
    for (const bad of [{}, { sku: "A" }, { name: "A" }, { sku: "A", name: "B", price: -1 }, { sku: "A", name: "B", price: "abc" }, { sku: "A", name: "B", stock: 1.5 },
      { sku: "A", name: "B", stock: -2 }, { sku: "A", name: "B", status: "sold" }, { sku: "A", name: "B", channels: [1] }, { sku: "A".repeat(65), name: "B" }]) {
      expect((await postProduct(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.calls.filter((c) => c.op === "insert")).toEqual([]);
  });
  it("a duplicate SKU is a 409, not a crash", async () => {
    h.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    expect((await postProduct({ sku: "CC-001", name: "Again" })).status).toBe(409);
  });
  it("edits a product only inside the organisation", async () => {
    h.calls.length = 0;
    const res = await patchProduct(P1, { sku: "CC-001", name: "Mini hoop XL", price: 1599, status: "low_stock" });
    expect(res.status).toBe(200);
    const upd = h.calls.find((c) => c.table === "products" && c.op === "update")!;
    expect(upd.eq).toMatchObject({ org_id: ORG, id: P1 });
    expect(upd.payload).not.toHaveProperty("org_id");
    expect((await patchProduct(P_OTHER, { sku: "X", name: "Hijack" })).status).toBe(404);
    expect((await patchProduct(P1, { sku: "", name: "x" })).status).toBe(400);
  });
  it("only owner, admin, approver and staff may write; a viewer gets 403", async () => {
    for (const role of ["owner", "admin", "approver", "staff"]) { setRole(role); expect((await postProduct({ sku: "S", name: "N" })).status, role).toBe(201); }
    setRole("viewer");
    expect((await postProduct({ sku: "S", name: "N" })).status).toBe(403);
    expect((await patchProduct(P1, { sku: "S", name: "N" })).status).toBe(403);
  });
  it("a database refusal (RLS) becomes a 403", async () => {
    h.insertError = { code: "42501", message: "new row violates row-level security policy" };
    expect((await postProduct({ sku: "S", name: "N" })).status).toBe(403);
  });
  it("a demo organisation keeps the sample catalogue and cannot create or edit", async () => {
    setMembership(true);
    expect((await getProducts()).some((p) => p.id === P1)).toBe(false);
    expect((await getProducts()).length).toBeGreaterThan(0);
    expect(await createProduct({ sku: "S", name: "N", category: null, price: null, stock: null, status: "draft", channels: [] })).toBeNull();
    expect(await updateProduct(P1, { sku: "S", name: "N", category: null, price: null, stock: null, status: "draft", channels: [] })).toBeNull();
    expect((await postProduct({ sku: "S", name: "N" })).status).toBe(404);
  });
  it("validation helper clamps to the table's limits", () => {
    expect(parseProductInput({ sku: " A ", name: " B " })).toEqual({ sku: "A", name: "B", category: null, price: null, stock: null, status: "draft", channels: [] });
    expect(parseProductInput({ sku: "A", name: "B", price: 100_000_000 })).toBeNull();
    expect(parseProductInput({ sku: "A", name: "B", price: "12.345" })?.price).toBe(12.35);
  });
});

describe("slice 3: live content calendar and approval workflow", () => {
  beforeEach(seedCatalogue);

  it("lists only this organisation's posts; a post's status follows its approval", async () => {
    const posts = await getSocialPosts();
    expect(posts.map((p) => p.title).sort()).toEqual(["Everyday stack", "Waiting"]);
    expect(posts.find((p) => p.id === POST1)).toMatchObject({ status: "draft", platform: "Instagram", scheduledFor: "2026-11-10", isSample: false, hashtags: ["#CheriAndCo"] });
    expect(posts.find((p) => p.id === POST_PENDING)!.status).toBe("approved"); // the approval was approved, whatever the stored status says
    expect(posts.every((p) => p.metrics === undefined)).toBe(true); // no engagement numbers exist in the schema
  });
  it("scopes content queries by organisation and falls back safely on odd rows", () => {
    expect(toSocialPost(contentRow({ scheduled_for: null, status: "published", topic: null, caption: null, hashtags: null }) as never))
      .toMatchObject({ scheduledFor: stamp.slice(0, 10), seedStatus: "draft", topic: "", caption: "", hashtags: [] }); // no approval behind it, so never approved
  });
  it("creates a draft in the session's organisation with a default planned date", async () => {
    h.calls.length = 0;
    const res = await postSocial(jreq("POST", "https://app.test/api/social/posts", { title: "New post", platform: "LinkedIn", caption: "Hello", hashtags: "#a #b", org_id: "attacker-org", status: "approved" }));
    expect(res.status).toBe(201);
    const ins = h.calls.find((c) => c.table === "content_items" && c.op === "insert")!;
    expect(ins.payload).toMatchObject({ org_id: ORG, platform: "LinkedIn", title: "New post", status: "draft", hashtags: ["#a", "#b"] });
    expect(ins.payload!.scheduled_for).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ins.payload).not.toHaveProperty("approval_id");
  });
  it("rejects a post with no title or an unsupported platform", async () => {
    h.calls.length = 0;
    expect((await postSocial(jreq("POST", "https://app.test/api/social/posts", { platform: "Instagram" }))).status).toBe(400);
    expect((await postSocial(jreq("POST", "https://app.test/api/social/posts", { title: "x", platform: "TikTok" }))).status).toBe(400);
    expect(h.calls.filter((c) => c.op === "insert")).toEqual([]);
  });
  it("edits a draft by updating its wording only (the status and approval link are never written by the app); refuses pending or foreign posts", async () => {
    h.calls.length = 0;
    const res = await postAction(POST1, "edit", { title: "Renamed", platform: "Instagram", caption: "New caption" });
    expect(res.status).toBe(200);
    const upd = h.calls.find((c) => c.table === "content_items" && c.op === "update")!;
    expect(upd.eq).toMatchObject({ org_id: ORG, id: POST1 });
    expect(upd.payload).toMatchObject({ title: "Renamed" });
    expect(upd.payload).not.toHaveProperty("status");
    expect(upd.payload).not.toHaveProperty("approval_id");
    expect(h.rpcCalls).toEqual([]); // a draft needs no reopening
    h.tables.approvals = h.tables.approvals!.map((a) => (a.id === APPROVAL_ID ? { ...a, status: "pending" } : a));
    expect((await postAction(POST_PENDING, "edit", { title: "x", platform: "Instagram" })).status).toBe(409);
    expect((await postAction(POST_OTHER, "edit", { title: "x", platform: "Instagram" })).status).toBe(404);
    expect((await postAction(POST1, "edit", { platform: "Instagram" })).status).toBe(400);
  });
  it("editing a rejected post reopens it through reopen_content first; the database decides whether that is allowed", async () => {
    h.tables.content_items = [contentRow({ status: "rejected", approval_id: APPROVAL_ID })];
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "t", type: "Content", generated_by: "content", status: "rejected", preview: "x", meta: { kind: "content_draft", postId: POST1 }, created_at: stamp }];
    h.calls.length = 0;
    expect((await postAction(POST1, "edit", { title: "Reworded", platform: "Instagram", caption: "Softer" })).status).toBe(200);
    expect(h.rpcCalls).toEqual([{ fn: "reopen_content", args: { p_post: POST1 } }]);
    const upd = h.calls.find((c) => c.table === "content_items" && c.op === "update")!;
    expect(upd.payload).not.toHaveProperty("status");
    expect(upd.payload).not.toHaveProperty("approval_id");
    h.rpcByFn.reopen_content = { data: null, error: { code: "42501", message: "not authorized" } };
    h.calls.length = 0;
    expect((await postAction(POST1, "edit", { title: "x", platform: "Instagram" })).status).toBe(403);
    expect(h.calls.some((c) => c.op === "update")).toBe(false); // nothing is edited when the reopening is refused
    h.rpcByFn.reopen_content = { data: null, error: { code: "P0001", message: "this post is waiting for a decision" } };
    expect((await postAction(POST1, "edit", { title: "x", platform: "Instagram" })).status).toBe(409);
    h.rpcByFn.reopen_content = { data: null, error: { code: "P0002", message: "not found" } };
    expect((await postAction(POST1, "edit", { title: "x", platform: "Instagram" })).status).toBe(404);
  });
  const submitOk = () => { h.rpcByFn.submit_content = (args) => {
    h.tables.content_items = h.tables.content_items!.map((r) => (r.id === args.p_post ? { ...r, status: "pending_approval", approval_id: "new-approval-1" } : r));
    return { data: "new-approval-1", error: null };
  }; };
  it("submitting is ONE database call (submit_content); the app writes no status, no approval and no link itself; nothing is published", async () => {
    submitOk();
    h.calls.length = 0;
    const res = await postAction(POST1, "submit");
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual([{ fn: "submit_content", args: { p_post: POST1 } }]); // only the post id is sent: the text and metadata are built by the database
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(((await res.json()) as { data: { status: string; approvalId: string } }).data).toMatchObject({ status: "pending_approval", approvalId: "new-approval-1" });
  });
  it("the database's refusals are mapped: not found 404, not a draft or no caption 409, prohibited claims 422 with details, no permission 403", async () => {
    const cases: [string, string, number][] = [["P0002", "not found", 404], ["P0001", "only drafts can be submitted for approval", 409], ["22023", "a caption is required", 409],
      ["23514", 'prohibited claims: price: "₹499"', 422], ["42501", "not authorized", 403]];
    for (const [code, message, status] of cases) {
      h.rpcByFn.submit_content = { data: null, error: { code, message } };
      expect((await postAction(POST1, "submit")).status, message).toBe(status);
    }
    h.rpcByFn.submit_content = { data: null, error: { code: "23514", message: 'prohibited claims: price: "₹499" | stock or scarcity: "hurry"' } };
    const body = (await (await postAction(POST1, "submit")).json()) as { issues?: string[] };
    expect(body.issues).toEqual(['price: "₹499"', 'stock or scarcity: "hurry"']);
  });
  it("F12: a post too long to send for approval is refused with a clear message before the database is called, and the database's own refusal is mapped the same way", async () => {
    h.tables.content_items = [contentRow({ hashtags: Array.from({ length: 150 }, (_, i) => `#tag${i}${"x".repeat(40)}`) })];
    h.rpcCalls.length = 0;
    const early = await postAction(POST1, "submit");
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toMatch(/too long to send for approval/);
    expect(h.rpcCalls).toEqual([]);
    h.tables.content_items = [contentRow({})];
    h.rpcByFn.submit_content = { data: null, error: { code: "22023", message: "the post is too long to send for approval (limit 6000 characters)" } };
    const late = await postAction(POST1, "submit");
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toMatch(/too long to send for approval/);
  });
  it("F6: prohibited wording in the title or the topic is caught before the database is called", async () => {
    for (const row of [contentRow({ title: "100% guaranteed waterproof" }), contentRow({ topic: "Lowest price of the year" })]) {
      h.tables.content_items = [row];
      h.rpcCalls.length = 0;
      const res = await postAction(POST1, "submit");
      expect(res.status).toBe(422);
      expect(((await res.json()) as { issues?: string[] }).issues?.length).toBeGreaterThan(0);
      expect(h.rpcCalls).toEqual([]);
    }
  });
  it("the claim guard blocks a draft with a price or discount before anything is written", async () => {
    h.tables.content_items = [contentRow({ caption: "Flat 50% off today, only 3 left in stock" })];
    h.calls.length = 0;
    const res = await postAction(POST1, "submit");
    expect(res.status).toBe(422);
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]);
  });
  it("refuses to submit an empty caption, a non-draft, or another organisation's post, without calling the database", async () => {
    h.tables.content_items = [contentRow({ caption: null }), contentRow({ id: POST_PENDING, status: "pending_approval", approval_id: APPROVAL_ID })];
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "t", type: "Content", generated_by: "content", status: "pending", preview: "x", meta: { kind: "content_draft", postId: POST_PENDING }, created_at: stamp }];
    h.rpcCalls.length = 0;
    expect((await postAction(POST1, "submit")).status).toBe(409);
    expect((await postAction(POST_PENDING, "submit")).status).toBe(409);
    expect((await postAction(POST_OTHER, "submit")).status).toBe(404);
    expect(h.rpcCalls).toEqual([]);
  });
  it("a viewer cannot create, edit or submit posts", async () => {
    setRole("viewer");
    expect((await postSocial(jreq("POST", "https://app.test/api/social/posts", { title: "x", platform: "Instagram" }))).status).toBe(403);
    expect((await postAction(POST1, "edit", { title: "x", platform: "Instagram" })).status).toBe(403);
    expect((await postAction(POST1, "submit")).status).toBe(403);
  });
  it("simulated publishing is not available to a live organisation", async () => {
    h.tables.approvals = h.tables.approvals!.map((a) => (a.id === APPROVAL_ID ? { ...a, status: "approved" } : a));
    h.calls.length = 0;
    expect((await postAction(POST_PENDING, "publish")).status).toBe(409);
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]);
  });
  it("deciding a content approval is only the decide_approval call; the database moves the post in the same transaction (no separate write)", async () => {
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "t", type: "Content", generated_by: "content", status: "pending", preview: "Soft light everyday stack", meta: { kind: "content_draft", subject: "x", isSample: false, allowedClaims: [], postId: POST_PENDING }, created_at: stamp }];
    h.rpcResult = { data: { id: APPROVAL_ID, title: "t", type: "Content", generated_by: "content", status: "rejected", preview: "x", meta: null, created_at: stamp }, error: null };
    h.calls.length = 0;
    expect(await decideApproval(APPROVAL_ID, "reject", "x", "needs work")).toMatchObject({ ok: true });
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(["decide_approval"]);
    expect(h.calls.filter((c) => c.table === "content_items" && c.op !== "select")).toEqual([]);
  });
  it("the orchestrator reports real planned-post counts for content", async () => {
    expect((await getOrchestratorBrief()).agents.find((a) => a.key === "content")!.headline).toBe("2 planned posts, 0 awaiting approval");
  });
  it("a demo organisation sees sample posts, not live rows, and live-only sections stay empty for live", async () => {
    setMembership(true);
    expect((await getSocialPosts()).some((p) => p.id === POST1)).toBe(false);
    expect((await getSocialPosts()).every((p) => p.isSample || p.id.startsWith("sp-"))).toBe(true);
    setMembership(false);
    expect((await getSocialPosts()).some((p) => p.isSample)).toBe(false);
  });
});

describe("slice 3: a submission cannot be left half done", () => {
  beforeEach(seedCatalogue);
  it("a database refusal on submit is a 403 and nothing else is written; any other failure is an error, with no compensating writes", async () => {
    h.rpcByFn.submit_content = { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
    h.calls.length = 0;
    expect((await postAction(POST1, "submit")).status).toBe(403);
    h.rpcByFn.submit_content = { data: null, error: { code: "XX000", message: "boom" } };
    await expect(postAction(POST1, "submit")).rejects.toBeDefined();
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]); // the database undoes a failed submission itself; the app has nothing to clean up
    expect(h.rpcCalls.every((c) => c.fn === "submit_content")).toBe(true);
  });
  it("no application path writes a post's status or approval link, or inserts an approval for a post, directly", async () => {
    h.rpcByFn.submit_content = { data: "new-approval-1", error: null };
    h.calls.length = 0;
    await postAction(POST1, "submit");
    await postAction(POST1, "edit", { title: "x", platform: "Instagram", caption: "ok" });
    h.rpcResult = { data: { id: APPROVAL_ID, title: "t", type: "Content", generated_by: "content", status: "approved", preview: "x", meta: null, created_at: stamp }, error: null };
    await decideApproval(APPROVAL_ID, "approve", "x");
    expect(h.calls.filter((c) => c.table === "approvals" && c.op !== "select")).toEqual([]);
    for (const c of h.calls.filter((x) => x.table === "content_items" && x.op === "update")) {
      expect(c.payload).not.toHaveProperty("status");
      expect(c.payload).not.toHaveProperty("approval_id");
    }
  });
  it("a post stuck at pending approval with no approval behind it shows as a draft and can be edited (through reopen_content)", async () => {
    h.tables.content_items = [contentRow({ status: "pending_approval", approval_id: null })];
    expect((await getSocialPosts())[0].status).toBe("draft");
    expect((await postAction(POST1, "edit", { title: "Fixed", platform: "Instagram", caption: "ok" })).status).toBe(200);
    expect(h.rpcCalls).toContainEqual({ fn: "reopen_content", args: { p_post: POST1 } });
  });
});

/* ---------- Slice 4: orders (fake client: proves app logic, not the real database) ---------- */
import { createOrder, getOrder, getOrders, updateOrderStatus } from "@/services";
import { parseOrderInput } from "@/lib/validate";
import { salesReport, toOrder } from "@/services/live-map";
import { GET as getResource } from "@/app/api/[resource]/route";

const O1 = "eeeeeeee-0000-4000-8000-000000000001";
const O_OTHER = "eeeeeeee-0000-4000-8000-000000000002";
const orderRow = (over: Row) => ({
  id: O1, org_id: ORG, customer_id: C1, retailer_id: null, channel: "instagram", status: "paid", total: "2499.50",
  line_items: [{ name: "Mini hoop", qty: 1 }], ordered_at: stamp, ...over,
});
const postOrder = (body: unknown) => postResource(jreq("POST", "https://app.test/api/orders", body), { params: Promise.resolve({ resource: "orders" }) });
const patchOrder = (id: string, body: unknown) => patchResource(jreq("PATCH", `https://app.test/api/orders/${id}`, body), { params: Promise.resolve({ resource: "orders", id }) });

describe("slice 4: live orders", () => {
  beforeEach(() => { seedPipeline(); h.tables.orders = [orderRow({}), orderRow({ id: O_OTHER, org_id: "other-org", total: 1 })]; });

  it("lists only this organisation's orders, scoped by the verified session's organisation", async () => {
    h.calls.length = 0;
    const list = await getOrders();
    expect(list.map((o) => o.id)).toEqual([O1]);
    expect(list[0]).toMatchObject({ customerId: C1, retailerId: null, channel: "instagram", status: "paid", total: 2499.5, lineItems: [{ name: "Mini hoop", qty: 1 }] });
    expect(h.calls.filter((c) => c.table === "orders").every((c) => c.eq.org_id === ORG)).toBe(true);
  });
  it("reads one order inside the organisation only", async () => {
    expect((await getOrder(O1))?.id).toBe(O1);
    expect(await getOrder(O_OTHER)).toBeNull();
    expect(await getOrder("not-a-uuid")).toBeNull();
  });
  it("falls back safely on unexpected stored values", () => {
    expect(toOrder(orderRow({ channel: "tiktok", status: "lost", line_items: "oops", total: 5 }) as never)).toMatchObject({ channel: "other", status: "new", lineItems: [], total: 5 });
    expect(toOrder(orderRow({ line_items: [1, null, ["x"], { ok: true }] }) as never).lineItems).toEqual([{ ok: true }]);
  });
  it("creates an order in the session's organisation with only the table's columns", async () => {
    h.calls.length = 0;
    const res = await postOrder({ channel: "amazon", total: "1999", customerId: C1, lineItems: [{ sku: "CC-1" }], org_id: "attacker-org", revenue: 5, id: "forced" });
    expect(res.status).toBe(201);
    const ins = h.calls.find((c) => c.table === "orders" && c.op === "insert")!;
    expect(ins.payload).toEqual({ org_id: ORG, customer_id: C1, retailer_id: null, channel: "amazon", status: "new", total: 1999, line_items: [{ sku: "CC-1" }] });
  });
  it("defaults to a new, zero-value order and rejects invalid input with 400 and no write", async () => {
    expect((await postOrder({ channel: "b2b" })).status).toBe(201);
    h.calls.length = 0;
    for (const bad of [{}, { channel: "tiktok" }, { channel: "b2b", status: "lost" }, { channel: "b2b", total: -1 }, { channel: "b2b", total: "abc" }, { channel: "b2b", total: 1e12 },
      { channel: "b2b", customerId: "nope" }, { channel: "b2b", lineItems: "x" }, { channel: "b2b", lineItems: [1] }, { channel: "b2b", lineItems: Array(101).fill({}) },
      { channel: "b2b", orderedAt: "yesterday" }]) {
      expect((await postOrder(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.calls.filter((c) => c.op === "insert")).toEqual([]);
  });
  it("a customer or retailer from another organisation is refused by the database (409), a refused write is 403", async () => {
    h.insertError = { code: "23503", message: "insert or update violates foreign key constraint" };
    expect((await postOrder({ channel: "b2b", customerId: C_OTHER })).status).toBe(409);
    h.insertError = { code: "42501", message: "new row violates row-level security policy" };
    expect((await postOrder({ channel: "b2b" })).status).toBe(403);
  });
  it("updates only the status, only inside the organisation", async () => {
    h.calls.length = 0;
    const res = await patchOrder(O1, { status: "shipped", total: 1, customerId: null });
    expect(res.status).toBe(200);
    const upd = h.calls.find((c) => c.table === "orders" && c.op === "update")!;
    expect(upd.payload).toEqual({ status: "shipped" });
    expect(upd.eq).toMatchObject({ org_id: ORG, id: O1 });
    expect((await patchOrder(O_OTHER, { status: "shipped" })).status).toBe(404);
    expect((await patchOrder(O1, { status: "lost" })).status).toBe(400);
    expect((await patchOrder(O1, {})).status).toBe(400);
  });
  it("owner, admin, approver and staff may write orders; a viewer may only read", async () => {
    for (const role of ["owner", "admin", "approver", "staff"]) { setRole(role); expect((await postOrder({ channel: "b2b" })).status, role).toBe(201); }
    setRole("viewer");
    expect((await postOrder({ channel: "b2b" })).status).toBe(403);
    expect((await patchOrder(O1, { status: "paid" })).status).toBe(403);
    const read = await getResource(new Request("https://app.test/api/orders", { headers: json }), { params: Promise.resolve({ resource: "orders" }) });
    expect(read.status).toBe(200);
    expect(((await read.json()) as unknown[]).length).toBe(1);
  });
  it("a demo organisation has no sample orders, never sees live rows and cannot write", async () => {
    setMembership(true);
    expect(await getOrders()).toEqual([]);
    expect(await getOrder(O1)).toBeNull();
    expect(await createOrder({ channel: "b2b" } as never)).toBeNull();
    expect(await updateOrderStatus(O1, "paid")).toBeNull();
    expect((await postOrder({ channel: "b2b" })).status).toBe(404);
    expect((await patchOrder(O1, { status: "paid" })).status).toBe(404);
  });
  it("customer purchase counts still come from the organisation's own orders", async () => {
    expect((await getCustomers()).find((c) => c.id === C1)?.purchases).toBe(1);
  });
  it("input parser keeps the table's limits and rounds to two decimals", () => {
    expect(parseOrderInput({ channel: "other", total: 10.005 })).toMatchObject({ status: "new", total: 10.01, lineItems: [], customerId: null });
    expect(parseOrderInput({ channel: "other", orderedAt: "2026-11-02T10:00:00Z" })?.orderedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(parseOrderInput(null)).toBeNull();
  });
});

describe("slice 4: revenue and purchase rules", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000 - 3_600_000).toISOString();
  beforeEach(() => {
    seedPipeline();
    h.tables.orders = [
      orderRow({ id: "o-new", status: "new", total: 100 }), orderRow({ id: "o-paid", status: "paid", total: 200 }), orderRow({ id: "o-shipped", status: "shipped", total: 400 }),
      orderRow({ id: "o-del-a", status: "delivered", total: "1000.50", ordered_at: daysAgo(3) }), orderRow({ id: "o-del-b", status: "delivered", total: 500, ordered_at: daysAgo(40) }),
      orderRow({ id: "o-del-prev", status: "delivered", total: 750, ordered_at: daysAgo(50) }), orderRow({ id: "o-del-old", status: "delivered", total: 9999, ordered_at: daysAgo(200) }),
      orderRow({ id: "o-cancelled", status: "cancelled", total: 800 }), orderRow({ id: "o-returned", status: "returned", total: 900 }),
      orderRow({ id: "o-other-org", org_id: "other-org", status: "delivered", total: 123456, ordered_at: daysAgo(2) }),
    ];
  });

  it("revenue counts delivered orders only, from this organisation, for the last twelve weeks", async () => {
    h.calls.length = 0;
    const [sales] = await getReports();
    const q = h.calls.find((c) => c.table === "orders")!;
    expect(q.eq).toMatchObject({ org_id: ORG, status: "delivered" });
    expect(sales.metrics.map((m) => [m.label, m.value])).toEqual([["Revenue (delivered)", "₹1,501"], ["Delivered orders", "2"], ["Average order value", "₹750"]]);
    expect(sales.series).toHaveLength(6);
    expect(sales.series.reduce((n, p) => n + p.value, 0)).toBeCloseTo(1.5005, 3); // ₹ thousand; excludes the other organisation and the 200-day-old order
    expect(sales.note).toMatch(/Only delivered orders count/);
  });
  it("is empty, not invented, when there are no delivered orders", async () => {
    h.tables.orders = [orderRow({ status: "paid" })];
    const [sales] = await getReports();
    expect(sales.metrics.map((m) => m.value)).toEqual(["₹0", "0", "—"]);
    expect(sales.metrics.every((m) => m.change === null)).toBe(true);
    expect(sales.series.every((p) => p.value === 0)).toBe(true);
  });
  it("salesReport buckets by rolling week, compares with the six weeks before and ignores future orders", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    const r = salesReport([
      { total: 100, ordered_at: at(1) }, { total: 300, ordered_at: at(40) }, // current period: Wk 6 and Wk 1
      { total: 200, ordered_at: at(50) }, // previous period
      { total: 5000, ordered_at: at(-3) }, // future: ignored
      { total: 5000, ordered_at: at(100) }, // too old: ignored
    ], now);
    expect(r.series.map((p) => p.value)).toEqual([0.3, 0, 0, 0, 0, 0.1]);
    expect(r.metrics[0]).toEqual({ label: "Revenue (delivered)", value: "₹400", change: 100 });
    expect(r.metrics[1]).toMatchObject({ value: "2", change: 100 });
  });
  it("only the Sales section exists for a live organisation; a demo organisation keeps all seven sample sections", async () => {
    expect((await getReports()).map((r) => r.id)).toEqual(["sales"]);
    setMembership(true);
    const demo = await getReports();
    expect(demo).toHaveLength(7);
    expect(demo[0].metrics[0].value).toBe("₹12.6L"); // the unchanged sample figure
  });
  it("customer purchases exclude cancelled and returned orders and count every other status", async () => {
    h.calls.length = 0;
    const list = await getCustomers();
    expect(list.find((c) => c.id === C1)?.purchases).toBe(7); // new, paid, shipped and all four delivered ones (age does not matter); not cancelled or returned; not the other organisation's
    expect(h.calls.find((c) => c.table === "orders")!.eq).toMatchObject({ org_id: ORG, "not:status": "in (cancelled,returned)" });
  });
  it("the customer list and the customer page use the same purchase rule", async () => {
    expect((await getCustomer(C1))?.purchases).toBe((await getCustomers()).find((c) => c.id === C1)?.purchases);
  });
  it("any role that can read can see the report; the report never writes", async () => {
    setRole("viewer");
    h.calls.length = 0;
    expect((await getReports()).map((r) => r.id)).toEqual(["sales"]);
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]);
  });
});


/* ---------- Stabilisation: refusals, paging, task assignee and postpone (fake client: application logic, not the real database) ---------- */
import { POST as decideRoute } from "@/app/api/approvals/[id]/[action]/route";
import { allRows, LIST_CAP, liveSalesReport } from "@/services/live";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskList } from "@/components/interactive";

const RLS_REFUSAL = { code: "42501", message: "new row violates row-level security policy" };
const patchTask = (id: string, body: unknown) => patchResource(jreq("PATCH", `https://app.test/api/tasks/${id}`, body), { params: Promise.resolve({ resource: "tasks", id }) });
const postTask = (body: unknown) => postResource(jreq("POST", "https://app.test/api/tasks", body), { params: Promise.resolve({ resource: "tasks" }) });
const patchPipeline = (id: string, body: unknown) => patchResource(jreq("PATCH", `https://app.test/api/pipeline/${id}`, body), { params: Promise.resolve({ resource: "pipeline", id }) });
const decide = (id: string, action: string, body?: unknown) => decideRoute(jreq("POST", `https://app.test/api/approvals/${id}/${action}`, body), { params: Promise.resolve({ id, action }) });

describe("a database refusal is a 403 on every write route, not a 500", () => {
  beforeEach(() => { seedPipeline(); });
  it("creating a task", async () => {
    h.insertError = RLS_REFUSAL;
    expect((await postTask({ title: "Call back" })).status).toBe(403);
  });
  it("updating a task", async () => {
    h.updateFault = () => RLS_REFUSAL;
    expect((await patchTask("t1", { status: "done" })).status).toBe(403);
  });
  it("moving a pipeline card", async () => {
    h.updateFault = () => RLS_REFUSAL;
    expect((await patchPipeline(L1, { stage: "won" })).status).toBe(403);
  });
  it("deciding an approval", async () => {
    h.rpcResult = { data: null, error: { code: "42501", message: "not authorized to decide approvals" } };
    expect((await decide("a1", "approve")).status).toBe(403);
    expect((await decide("a1", "reject")).status).toBe(403);
  });
  it("an unrelated database failure is still an error, not disguised as a refusal", async () => {
    h.updateFault = () => ({ code: "XX000", message: "internal failure" });
    await expect(patchTask("t1", { status: "done" })).rejects.toThrow(/Database request failed/);
  });
  it("a viewer is refused before the database is reached", async () => {
    setRole("viewer"); h.calls.length = 0;
    expect((await postTask({ title: "x" })).status).toBe(403);
    expect((await patchTask("t1", { status: "done" })).status).toBe(403);
    expect((await patchPipeline(L1, { stage: "won" })).status).toBe(403);
    expect((await decide("a1", "approve")).status).toBe(403);
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(h.rpcCalls).toEqual([]);
  });
  it("only owner, admin and approver may decide; staff may not", async () => {
    for (const role of ["owner", "admin", "approver"]) {
      setRole(role);
      h.rpcResult = { data: { id: "a1", title: "t", type: "Instagram reply", generated_by: "b2c", status: "approved", preview: "p", meta: null, created_at: stamp }, error: null };
      expect((await decide("a1", "approve")).status, role).toBe(200);
    }
    setRole("staff");
    expect((await decide("a1", "approve")).status).toBe(403);
  });
});

describe("live tasks: assignee and postpone", () => {
  beforeEach(() => { h.tables.tasks[0] = { ...h.tables.tasks[0], due_at: "2026-11-10T10:00:00.000Z" }; });
  it("an assignee change is refused instead of reporting a save that did not happen", async () => {
    h.calls.length = 0;
    const res = await patchTask("t1", { assignee: "Dev" });
    expect(res.status).toBe(409);
    expect(h.calls.some((c) => c.op === "update")).toBe(false);
    expect((await patchTask("t1", { status: "done", assignee: "Dev" })).status).toBe(409);
  });
  it("Postpone moves the due date one day later and keeps it, instead of clearing it", async () => {
    h.calls.length = 0;
    const res = await patchTask("t1", { status: "postponed", due: "Postponed +1 day" });
    expect(res.status).toBe(200);
    const upd = h.calls.find((c) => c.table === "tasks" && c.op === "update")!;
    expect(upd.payload).toEqual({ status: "postponed", due_at: "2026-11-11T10:00:00.000Z" });
    expect(upd.eq).toMatchObject({ org_id: ORG, id: "t1" });
  });
  it("Postpone on a task with no due date sets one day from now, and on another organisation's task is a 404", async () => {
    h.tables.tasks[0] = { ...h.tables.tasks[0], due_at: null };
    const before = Date.now();
    await patchTask("t1", { status: "postponed", due: "Postponed +1 day" });
    const due = Date.parse(String((h.calls.find((c) => c.op === "update")!.payload as Row).due_at));
    expect(due).toBeGreaterThanOrEqual(before + 86_400_000 - 1000);
    expect((await patchTask("t2", { status: "postponed", due: "Postponed +1 day" })).status).toBe(404);
  });
  it("the live task list shows the assignee as text and offers no name picker; the demo keeps its picker", () => {
    const tasks = [{ id: "t1", title: "Call Asha", source: "Manual", due: "Today", priority: "high", assignee: "Unassigned", status: "open", href: "/tasks" }] as never;
    const live = renderToStaticMarkup(createElement(TaskList, { initial: tasks, live: true }));
    expect(live).toContain("Unassigned");
    expect(live).not.toContain("<select");
    expect(live).not.toContain("Anika");
    expect(renderToStaticMarkup(createElement(TaskList, { initial: tasks }))).toContain("<select");
  });
});

describe("lists are complete, or refused: nothing is cut short quietly", () => {
  const manyCustomers = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c-${String(i).padStart(5, "0")}`, org_id: ORG, name: `Customer ${i}`, instagram: null, phone: null, email: null, city: null, interests: [], created_at: stamp }));
  it("returns all 2,500 customers even though one response carries at most 1,000 rows", async () => {
    h.tables.customers = manyCustomers(2500); h.tables.orders = []; h.calls.length = 0;
    expect((await getCustomers()).length).toBe(2500);
    expect(h.calls.filter((c) => c.table === "customers" && c.range).map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("a list of exactly one page needs one extra empty page and loses nothing", async () => {
    h.tables.customers = manyCustomers(1000); h.tables.orders = [];
    expect((await getCustomers()).length).toBe(1000);
  });
  it("purchase counts read every order, not only the first 1,000", async () => {
    h.tables.customers = [{ ...manyCustomers(1)[0], id: C1 }];
    h.tables.orders = Array.from({ length: 2500 }, () => ({ customer_id: C1, org_id: ORG, status: "paid" }));
    expect((await getCustomers())[0].purchases).toBe(2500);
  });
  it("the Sales report totals every delivered order (2,500 orders of 100.00 in the latest week)", async () => {
    const now = new Date("2026-11-20T12:00:00Z");
    h.tables.orders = Array.from({ length: 2500 }, () => ({ org_id: ORG, status: "delivered", total: "100.00", ordered_at: "2026-11-19T12:00:00Z" }));
    const sales = await liveSalesReport(now);
    expect(sales.metrics[1].value).toBe("2,500");
    expect(sales.metrics[0].value).toBe("₹2,50,000");
  });
  it("tasks are complete as well (no 200-row cut)", async () => {
    h.tables.tasks = Array.from({ length: 1200 }, (_, i) => ({ id: `t-${i}`, org_id: ORG, title: `T${i}`, source: "Manual", due_at: null, priority: "low", status: "open", assignee_id: null, related_ref: null }));
    expect((await getTasks()).length).toBe(1200);
  });
  it("a list beyond the hard cap is an error, not a short list", async () => {
    const page = async (from: number, to: number) => ({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ n: from + i })), error: null });
    await expect(allRows(page, 2500)).rejects.toThrow(/Too many records/);
    expect(LIST_CAP).toBe(10_000);
    const small = async (from: number) => ({ data: from === 0 ? [{ n: 1 }, { n: 2 }] : [], error: null });
    expect(await allRows(small)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("a database error while paging is surfaced (a refusal as an AuthError, anything else as an error)", async () => {
    await expect(allRows(async () => ({ data: null, error: RLS_REFUSAL }))).rejects.toBeInstanceOf(AuthError);
    await expect(allRows(async () => ({ data: null, error: { message: "boom" } }))).rejects.toThrow(/Database request failed/);
  });
});


/* ---------- Sweep: every read route, for a live organisation, returns neither sample data nor another organisation's rows ---------- */
import { GET as getAgentsView } from "@/app/api/agents/[view]/route";
import { GET as getAmazonRoute } from "@/app/api/amazon/insights/route";
import { GET as getDiscoverRoute } from "@/app/api/b2b/discover/route";
import { GET as getCalendarRoute } from "@/app/api/content/calendar/route";
import { GET as getSuggestionsRoute } from "@/app/api/crm/suggestions/route";
import { GET as getSummaryRoute } from "@/app/api/dashboard/summary/route";
import { GET as getSocialRoute } from "@/app/api/social/posts/route";
import { GET as getOneResource } from "@/app/api/[resource]/[id]/route";

describe("live organisation: no read route leaks sample data or another organisation's rows", () => {
  const SAMPLE = /SAMPLE|Aurelia|Moonlit|Priya Sharma|Ananya|Mira Boutique|Anika|amazonClicks/i;
  const get = (url: string) => new Request(url, { headers: json });
  const resources = ["leads", "customers", "retailers", "conversations", "products", "orders", "content", "tasks", "approvals", "reports"];

  beforeEach(() => {
    h.tables.orders = [{ id: "o-other", org_id: "other-org", customer_id: null, retailer_id: null, channel: "amazon", status: "delivered", total: "999", line_items: [], ordered_at: stamp }];
    h.tables.customers = [{ id: "c-other", org_id: "other-org", name: "Not mine customer", instagram: null, phone: null, email: null, city: null, interests: [], created_at: stamp }];
    h.tables.retailers = []; h.tables.leads = []; h.tables.products = []; h.tables.content_items = [];
  });

  it("every collection and view route", async () => {
    const bodies: Record<string, string> = {};
    for (const r of resources) bodies[r] = await (await getResource(get(`https://app.test/api/${r}`), { params: Promise.resolve({ resource: r }) })).text();
    bodies.status = await (await getAgentsView(get("https://app.test/api/agents/status"), { params: Promise.resolve({ view: "status" }) })).text();
    bodies.activity = await (await getAgentsView(get("https://app.test/api/agents/activity"), { params: Promise.resolve({ view: "activity" }) })).text();
    bodies.amazon = await (await getAmazonRoute()).text();
    bodies.discover = await (await getDiscoverRoute()).text();
    bodies.calendar = await (await getCalendarRoute()).text();
    bodies.suggestions = await (await getSuggestionsRoute()).text();
    bodies.summary = await (await getSummaryRoute(get("https://app.test/api/dashboard/summary?range=30d"))).text();
    bodies.social = await (await getSocialRoute()).text();
    for (const [name, body] of Object.entries(bodies)) {
      if (name !== "discover") expect(body, name).not.toMatch(SAMPLE); // discover returns only a label ("SAMPLE candidates...") and an empty list
      expect(body, name).not.toMatch(/Not mine|other-org|o-other|c-other/);
    }
    expect(JSON.parse(bodies.customers)).toEqual([]);
    expect(JSON.parse(bodies.orders)).toEqual([]);
    expect(JSON.parse(bodies.discover).data.candidates).toEqual([]);
  });

  it("single-record routes refuse another organisation's id and any sample id", async () => {
    for (const [resource, id] of [["customers", "c-other"], ["customers", "c1"], ["retailers", "r1"], ["products", "p1"], ["orders", "o-other"]] as const) {
      const res = await getOneResource(get(`https://app.test/api/${resource}/${id}`), { params: Promise.resolve({ resource, id }) });
      expect(res.status, `${resource}/${id}`).toBe(404);
    }
  });

  it("a signed-in user with no membership gets 403 from every read route", async () => {
    h.tables.memberships = [];
    for (const r of resources) {
      const res = await getResource(get(`https://app.test/api/${r}`), { params: Promise.resolve({ resource: r }) });
      expect(res.status, r).toBe(403);
    }
    expect((await getSummaryRoute(get("https://app.test/api/dashboard/summary"))).status).toBe(403);
    expect((await getSocialRoute()).status).toBe(403);
  });

  it("a demo organisation (is_demo) still gets sample data from the same routes", async () => {
    setMembership(true);
    expect(await (await getSummaryRoute(get("https://app.test/api/dashboard/summary"))).text()).toMatch(SAMPLE);
  });
});


describe("a post is approved only when a human approval raised for that very post says so", () => {
  const POST_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  beforeEach(() => { seedCatalogue(); });
  it("a status set by hand (approved or published, no approval) is shown as a draft", async () => {
    h.tables.content_items = [contentRow({ status: "approved", approval_id: null }), contentRow({ id: POST_B, status: "published", approval_id: null })];
    const posts = await getSocialPosts();
    expect(posts.map((p) => p.status)).toEqual(["draft", "draft"]);
  });
  it("a post pointed at another post's approved approval is not approved", async () => {
    // APPROVAL_ID was raised for POST_PENDING; POST1 is re-pointed at it by a writer calling the database directly
    h.tables.content_items = [contentRow({ id: POST1, status: "approved", approval_id: APPROVAL_ID }), contentRow({ id: POST_PENDING, status: "approved", approval_id: APPROVAL_ID })];
    const posts = await getSocialPosts();
    expect(posts.find((p) => p.id === POST1)!.status).toBe("draft");
    expect(posts.find((p) => p.id === POST_PENDING)!.status).toBe("approved");
  });
  it("an approval without the post id (not raised by this app) does not approve anything", async () => {
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "x", type: "Content", generated_by: "content", status: "approved", preview: "x", meta: null, created_at: stamp }];
    h.tables.content_items = [contentRow({ id: POST1, status: "approved", approval_id: APPROVAL_ID })];
    expect((await getSocialPosts())[0].status).toBe("draft");
  });
  it("an approval is trusted for a post only when its metadata names that post (the database writes it at submit time)", async () => {
    h.tables.content_items = [contentRow({ id: POST1, status: "approved", approval_id: APPROVAL_ID })];
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "x", type: "Content", generated_by: "content", status: "approved", preview: "x", meta: { kind: "content_draft", postId: POST1 }, created_at: stamp }];
    expect((await getSocialPosts())[0].status).toBe("approved");
  });
});
