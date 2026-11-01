/** Live data slice: tasks, approvals, audit log and agent activity read and written through the user's own Supabase
 *  session. The Supabase client is a recording fake, so these tests prove the application logic (org scoping, mapping,
 *  no mixing with sample data, error handling). They do NOT prove the real database: see docs/rls_live_check.sql. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
interface Call { table: string; op: string; eq: Row; payload?: Row }
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as { table: string; op: string; eq: Record<string, unknown>; payload?: Record<string, unknown> }[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: { data: null, error: null } as { data: unknown; error: { code?: string; message: string } | null },
  insertError: null as { code?: string; message: string } | null,
  /** Makes a matching update fail with an error, or match no rows when it returns "empty". */
  updateFault: null as null | ((table: string, payload: Record<string, unknown>) => { code?: string; message: string } | "empty" | null),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => { h.rpcCalls.push({ fn, args }); return h.rpcResult; },
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
          resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
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
  h.calls.length = 0; h.rpcCalls.length = 0; h.insertError = null; h.updateFault = null;
  h.rpcResult = { data: null, error: null };
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
  h.tables.approvals = [...(h.tables.approvals ?? []), { id: APPROVAL_ID, org_id: ORG, title: "Waiting · Instagram post", type: "Content", generated_by: "content", status: "approved", preview: "x", meta: null, created_at: stamp }];
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
      .toMatchObject({ scheduledFor: stamp.slice(0, 10), seedStatus: "approved", topic: "", caption: "", hashtags: [] });
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
  it("edits a draft (and resets it to a draft with no approval); refuses pending or foreign posts", async () => {
    h.calls.length = 0;
    const res = await postAction(POST1, "edit", { title: "Renamed", platform: "Instagram", caption: "New caption" });
    expect(res.status).toBe(200);
    const upd = h.calls.find((c) => c.table === "content_items" && c.op === "update")!;
    expect(upd.eq).toMatchObject({ org_id: ORG, id: POST1 });
    expect(upd.payload).toMatchObject({ title: "Renamed", status: "draft", approval_id: null });
    h.tables.approvals = h.tables.approvals!.map((a) => (a.id === APPROVAL_ID ? { ...a, status: "pending" } : a));
    expect((await postAction(POST_PENDING, "edit", { title: "x", platform: "Instagram" })).status).toBe(409);
    expect((await postAction(POST_OTHER, "edit", { title: "x", platform: "Instagram" })).status).toBe(404);
    expect((await postAction(POST1, "edit", { platform: "Instagram" })).status).toBe(400);
  });
  it("submitting claims the draft, queues a pending approval and links it; nothing is published", async () => {
    h.calls.length = 0;
    const res = await postAction(POST1, "submit");
    expect(res.status).toBe(200);
    const writes = h.calls.filter((c) => c.op !== "select").map((c) => `${c.table}:${c.op}`);
    expect(writes.slice(0, 3)).toEqual(["content_items:update", "approvals:insert", "content_items:update"]);
    const claim = h.calls.find((c) => c.table === "content_items" && c.op === "update")!;
    expect(claim.eq).toMatchObject({ org_id: ORG, id: POST1, status: "draft" });
    expect(claim.payload).toEqual({ status: "pending_approval" });
    const approval = h.calls.find((c) => c.table === "approvals" && c.op === "insert")!;
    expect(approval.payload).toMatchObject({ org_id: ORG, type: "Content", generated_by: "content", status: "pending", meta: { kind: "content_draft", isSample: false, allowedClaims: [] } });
    expect(JSON.stringify(approval.payload)).not.toContain('"status":"published"');
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe("pending_approval");
  });
  it("the claim guard blocks a draft with a price or discount before anything is written", async () => {
    h.tables.content_items = [contentRow({ caption: "Flat 50% off today, only 3 left in stock" })];
    h.calls.length = 0;
    const res = await postAction(POST1, "submit");
    expect(res.status).toBe(422);
    expect(h.calls.filter((c) => c.op !== "select")).toEqual([]);
  });
  it("refuses to submit an empty caption, a non-draft, or another organisation's post", async () => {
    h.tables.content_items = [contentRow({ caption: null }), contentRow({ id: POST_PENDING, status: "pending_approval", approval_id: APPROVAL_ID })];
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "t", type: "Content", generated_by: "content", status: "pending", preview: "x", meta: null, created_at: stamp }];
    expect((await postAction(POST1, "submit")).status).toBe(409);
    expect((await postAction(POST_PENDING, "submit")).status).toBe(409);
    expect((await postAction(POST_OTHER, "submit")).status).toBe(404);
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
  it("deciding a content approval keeps the post's stored status in step", async () => {
    h.tables.approvals = [{ id: APPROVAL_ID, org_id: ORG, title: "t", type: "Content", generated_by: "content", status: "pending", preview: "Soft light everyday stack", meta: { kind: "content_draft", subject: "x", isSample: false, allowedClaims: [] }, created_at: stamp }];
    h.rpcResult = { data: { id: APPROVAL_ID, title: "t", type: "Content", generated_by: "content", status: "rejected", preview: "x", meta: null, created_at: stamp }, error: null };
    h.calls.length = 0;
    expect(await decideApproval(APPROVAL_ID, "reject", "x", "needs work")).toMatchObject({ ok: true });
    const sync = h.calls.find((c) => c.table === "content_items" && c.op === "update")!;
    expect(sync.payload).toEqual({ status: "rejected" });
    expect(sync.eq).toMatchObject({ org_id: ORG, approval_id: APPROVAL_ID });
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

describe("slice 3: a submission that cannot be completed", () => {
  beforeEach(seedCatalogue);
  const linkFault = (fault: { code?: string; message: string } | "empty") => { h.updateFault = (t, payload) => (t === "content_items" && "approval_id" in payload ? fault : null); };

  it("if the approval cannot be linked, the post goes back to a draft and the unlinked approval is rejected through decide_approval", async () => {
    linkFault({ code: "XX000", message: "boom" });
    h.calls.length = 0;
    await expect(postAction(POST1, "submit")).rejects.toBeDefined();
    const updates = h.calls.filter((c) => c.table === "content_items" && c.op === "update").map((c) => c.payload);
    expect(updates).toContainEqual({ status: "draft" });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]).toMatchObject({ fn: "decide_approval", args: { p_id: "new-1", p_action: "reject" } });
    expect(h.calls.some((c) => c.table === "approvals" && (c.op === "update" || c.op === "delete"))).toBe(false); // approvals are never touched directly
  });
  it("a link that matches no row (post removed meanwhile) is a 404, not a false success, and is undone the same way", async () => {
    linkFault("empty");
    h.rpcCalls.length = 0;
    expect((await postAction(POST1, "submit")).status).toBe(404);
    expect(h.rpcCalls[0]).toMatchObject({ fn: "decide_approval", args: { p_action: "reject" } });
  });
  it("a role that may not decide approvals still gets the post back as a draft (the unlinked approval then stays pending)", async () => {
    linkFault({ code: "XX000", message: "boom" });
    h.rpcResult = { data: null, error: { code: "42501", message: "not authorized" } };
    h.calls.length = 0;
    await expect(postAction(POST1, "submit")).rejects.toBeDefined();
    expect(h.calls.some((c) => c.table === "content_items" && c.op === "update" && c.payload?.status === "draft")).toBe(true);
  });
  it("a post stuck at pending approval with no approval behind it shows as a draft and can be edited", async () => {
    h.tables.content_items = [contentRow({ status: "pending_approval", approval_id: null })];
    expect((await getSocialPosts())[0].status).toBe("draft");
    expect((await postAction(POST1, "edit", { title: "Fixed", platform: "Instagram", caption: "ok" })).status).toBe(200);
  });
  it("if claiming the draft is refused by the database, nothing else is written", async () => {
    h.updateFault = (t, payload) => (t === "content_items" && payload.status === "pending_approval" ? { code: "42501", message: "row-level security" } : null);
    h.calls.length = 0;
    expect((await postAction(POST1, "submit")).status).toBe(403);
    expect(h.calls.some((c) => c.table === "approvals" && c.op === "insert")).toBe(false);
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
