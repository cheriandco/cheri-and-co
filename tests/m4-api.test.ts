/** M4: B2C follow-up drafts (from customers and orders) queued to Approvals in a live organisation, through the real route handlers and services.
 *  The Supabase client is a recording fake (same approach as tests/m2-api.test.ts): these tests prove the application logic
 *  (organisation scoping, permissions, duplicate refusal, claim guard, what is and is not written). They do NOT prove the real
 *  database, RLS or decide_approval(); that is what the staging run (M1) is for. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
interface Call { table: string; op: string; eq: Row; payload?: Row; range?: [number, number] }
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { table: string; op: string; eq: Record<string, unknown>; payload?: Record<string, unknown>; range?: [number, number] }[],
  insertFault: null as null | ((table: string, n: number) => { code?: string; message: string } | null),
  inserts: 0,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: null as null | ((args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      return h.rpcResult ? h.rpcResult(args) : { data: null, error: null };
    },
    from: (table: string) => {
      const call: Call = { table, op: "select", eq: {} };
      h.calls.push(call);
      let single = false;
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (payload: Row) => { call.op = "insert"; call.payload = payload; return q; },
        update: (payload: Row) => { call.op = "update"; call.payload = payload; return q; },
        eq: (k: string, v: unknown) => { call.eq[k] = v; return q; },
        not: () => q, gte: () => q, in: () => q, order: () => q, limit: () => q,
        range: (a: number, b: number) => { call.range = [a, b]; return q; },
        single: () => { single = true; return q; },
        maybeSingle: () => { single = true; return q; },
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          if (call.op === "insert") {
            const fault = h.insertFault?.(table, ++h.inserts);
            if (fault) return resolve({ data: null, error: fault });
          }
          const all = h.tables[table] ?? [];
          const rows = call.op === "insert" ? [{ id: "new-1", created_at: new Date().toISOString(), ...call.payload }]
            : all.filter((r) => Object.entries(call.eq).every(([k, v]) => r[k] === v)).map((r) => (call.op === "update" ? { ...r, ...call.payload } : r));
          const paged = call.range ? rows.slice(call.range[0], call.range[1] + 1) : rows;
          resolve({ data: single ? (rows[0] ?? null) : paged, error: null });
        },
      };
      return q;
    },
  }),
}));

import { POST as queueRoute } from "@/app/api/agent-actions/route";
import { queueAgentAction, getActionLinks, decideApproval, getB2cOpportunities, getOrchestratorBrief } from "@/services";
import { CONSENT_WARNING } from "@/lib/b2c-opportunities";
import { findProhibitedClaims } from "@/lib/content-agent/claims";

const ORG = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "23232323-2323-4323-8323-232323232323";
const C_NOORD = "24242424-2424-4424-8424-242424242424";
const C_OTHER = "55555555-5555-4555-8555-555555555555";
const A1 = "77777777-7777-4777-8777-777777777777";
const A2 = "88888888-8888-4888-8888-888888888888";
const DAY = 86_400_000;
const stamp = new Date().toISOString();
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const RLS_REFUSAL = { code: "42501", message: "new row violates row-level security policy" };
const setMembership = (role: string, isDemo = false) => { h.tables.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: isDemo } }]; };
const cust = (id: string, org: string, name: string, over: Row = {}) => ({ id, org_id: org, name, instagram: null, phone: null, email: `${name.split(" ")[0].toLowerCase()}@example.com`, city: null, interests: [], created_at: stamp, ...over });
const ord = (id: string, customer: string, status: string, days: number, org = ORG) => ({ id, org_id: org, customer_id: customer, retailer_id: null, channel: "instagram", status, total: 1499, line_items: [], ordered_at: ago(days) });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "required");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  h.calls.length = 0; h.insertFault = null; h.inserts = 0; h.rpcs.length = 0; h.rpcResult = null;
  fetchSpy = vi.spyOn(globalThis, "fetch");
  h.tables = {
    customers: [cust(C1, ORG, "Meera Iyer"), cust(C2, ORG, "Asha Rao"), cust(C_NOORD, ORG, "No Orders"), cust(C_OTHER, "other-org", "Not Mine")],
    orders: [ord("o1", C1, "delivered", 45), ord("o2", C2, "delivered", 200), ord("o3", C_OTHER, "delivered", 45, "other-org")],
    approvals: [], agent_activity: [], profiles: [], retailers: [], leads: [], tasks: [],
  };
  setMembership("owner");
});
afterEach(() => { vi.unstubAllEnvs(); fetchSpy.mockRestore(); });

const headers = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const queue = (body: unknown, extra: Record<string, string> = {}) =>
  queueRoute(new Request("https://app.test/api/agent-actions", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) }));
const inserts = (table: string) => h.calls.filter((c) => c.table === table && c.op === "insert");
const writes = () => h.calls.filter((c) => c.op !== "select");
const followMeta = { kind: "b2c_followup", agent: "b2c", ref: C1, isSample: false, allowedClaims: [], subject: "Meera Iyer" };
const approvalRow = (over: Row = {}) => ({ id: A1, org_id: ORG, status: "pending", title: "B2C follow-up — Meera Iyer", type: "B2C Follow-up", generated_by: "b2c", preview: "Hi Meera,", created_at: stamp, meta: followMeta, ...over });

describe("M4: a B2C follow-up reaches Approvals in a live organisation", () => {
  it("queues a pending 'B2C Follow-up' for the signed-in organisation, built on the server; the browser sends only the id", async () => {
    const res = await queue({ agent: "b2c", ref: C1, preview: "attacker text", org_id: "other-org", title: "x" });
    expect(res.status).toBe(201);
    const ins = inserts("approvals");
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toMatchObject({ org_id: ORG, type: "B2C Follow-up", generated_by: "b2c", status: "pending" });
    const preview = String(ins[0].payload!.preview);
    expect(preview).toContain("Hi Meera,");
    expect(preview).not.toContain("attacker text");
    expect(preview).toContain(CONSENT_WARNING);
    expect(ins[0].payload!.meta).toMatchObject({ kind: "b2c_followup", agent: "b2c", ref: C1, isSample: false, allowedClaims: [], opportunity: "repeat_nudge", orderId: "o1", consentRecorded: false });
    expect(await res.json()).toMatchObject({ data: { status: "pending", generatedBy: "b2c", type: "B2C Follow-up" } });
  });

  it("builds a win-back for a long-quiet customer from the saved order, with no invented purchase detail", async () => {
    const res = await queue({ agent: "b2c", ref: C2 });
    expect(res.status).toBe(201);
    const meta = inserts("approvals")[0].payload!.meta as Row;
    expect(meta.opportunity).toBe("win_back");
    expect(String(inserts("approvals")[0].payload!.preview)).not.toMatch(/₹|1499|\d+\s?%/);
  });

  it("writes only an approval and one activity line; no customer, order or decision is changed; no outbound request is made", async () => {
    await queue({ agent: "b2c", ref: C1 });
    expect([...new Set(writes().map((c) => `${c.table}:${c.op}`))].sort()).toEqual(["agent_activity:insert", "approvals:insert"]);
    expect(h.rpcs).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records the signed-in submitter and the b2c agent in the activity history", async () => {
    await queue({ agent: "b2c", ref: C1 });
    const log = inserts("agent_activity")[0].payload!;
    expect(log).toMatchObject({ org_id: ORG, agent: "b2c", actor_id: "u1" });
    expect(String(log.action)).toContain("Meera Iyer");
    expect(String(log.action)).toMatch(/not sent to the customer/);
  });

  it("refuses a duplicate while one is pending (409); a decided one does not block; B2B and B2C keys do not collide", async () => {
    h.tables.approvals = [approvalRow()];
    const dup = await queue({ agent: "b2c", ref: C1 });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already waiting/i);
    expect(inserts("approvals")).toHaveLength(0);
    h.tables.approvals[0].status = "approved";
    expect((await queue({ agent: "b2c", ref: C1 })).status).toBe(201);
    h.tables.approvals = [approvalRow({ meta: { ...followMeta, kind: "b2b_followup", agent: "b2b" } })];
    expect((await queue({ agent: "b2c", ref: C1 })).status).toBe(201);
  });

  it("another organisation's customer, an unknown id and a malformed id are 404 and write nothing", async () => {
    for (const ref of [C_OTHER, "99999999-9999-4999-8999-999999999999", "not-a-uuid"]) expect((await queue({ agent: "b2c", ref })).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it("only this organisation's orders decide the opportunity: a newer order row in another organisation is ignored", async () => {
    h.tables.orders.push(ord("o9", C1, "paid", 1, "other-org"));
    expect((await queue({ agent: "b2c", ref: C1 })).status).toBe(201);
  });

  it("refuses (409) customers with no current opportunity, returned or cancelled latest orders and no usable contact; nothing is written", async () => {
    h.tables.orders.push(ord("o4", C_NOORD, "returned", 5));
    expect((await queue({ agent: "b2c", ref: C_NOORD })).status).toBe(409);
    h.tables.customers.push(cust("31313131-3131-4331-8331-313131313131", ORG, "Quiet Person"));
    h.tables.orders.push(ord("o5", "31313131-3131-4331-8331-313131313131", "paid", 2));
    expect((await queue({ agent: "b2c", ref: "31313131-3131-4331-8331-313131313131" })).status).toBe(409);
    h.tables.customers[0].email = ""; h.tables.customers[0].phone = "";
    const res = await queue({ agent: "b2c", ref: C1 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no usable email or phone/i);
    expect(writes()).toHaveLength(0);
  });

  it("a customer with no orders at all is not an opportunity (no records are invented)", async () => {
    const res = await queue({ agent: "b2c", ref: C_NOORD });
    expect(res.status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it("wording that needs a client-approved claim is refused (422) before anything is written", async () => {
    h.tables.customers[0].name = "Hypoallergenic guaranteed cure";
    const res = await queue({ agent: "b2c", ref: C1 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/client-approved claims/i);
    expect(writes()).toHaveLength(0);
  });

  it("a viewer is 403, a cross-site request is 403, a bad body is 400; nothing is written", async () => {
    setMembership("viewer");
    expect((await queue({ agent: "b2c", ref: C1 })).status).toBe(403);
    setMembership("staff");
    expect((await queue({ agent: "b2c", ref: C1 }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await queue({ agent: "b2c" })).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it("staff, approver and admin may queue; a database refusal is 403 and leaves no activity line", async () => {
    for (const role of ["staff", "approver", "admin"]) { setMembership(role); expect((await queue({ agent: "b2c", ref: C1 })).status).toBe(201); }
    h.insertFault = (table) => (table === "approvals" ? RLS_REFUSAL : null);
    h.calls.length = 0;
    expect((await queue({ agent: "b2c", ref: C1 })).status).toBe(403);
    expect(inserts("agent_activity")).toHaveLength(0);
  });

  it("Amazon stays disconnected for a live organisation", async () => {
    const res = await queue({ agent: "amazon", ref: "anything" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/not connected to a data source/i);
    expect(writes()).toHaveLength(0);
  });
});

describe("M4: the opportunity list, links and the dashboard headline", () => {
  it("lists only this organisation's opportunities and writes nothing", async () => {
    const opps = await getB2cOpportunities();
    expect(opps.map((o) => [o.customerName, o.kind])).toEqual([["Meera Iyer", "repeat_nudge"], ["Asha Rao", "win_back"]]);
    expect(opps.some((o) => o.customerId === C_OTHER)).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("getActionLinks maps b2c:<customer> to the newest approval and its decision", async () => {
    h.tables.approvals = [approvalRow({ id: A2, status: "pending" }), approvalRow({ id: A1, status: "approved" })];
    expect(await getActionLinks()).toEqual({ [`b2c:${C1}`]: { approvalId: A2, status: "pending" } });
  });

  it("the orchestrator's B2C headline counts the organisation's opportunities", async () => {
    const brief = await getOrchestratorBrief();
    expect(brief.agents.find((a) => a.key === "b2c")!.headline).toBe("2 customer follow-up opportunities to review");
  });
});

describe("M4: decisions and the claim guard at approval", () => {
  it("approving goes through decide_approval (the audit row is written there); no other table is written; nothing is sent", async () => {
    h.tables.approvals = [approvalRow({ preview: "Hi Meera, we hope your order reached you safely." })];
    h.rpcResult = () => ({ data: approvalRow({ status: "approved" }), error: null });
    expect(await decideApproval(A1, "approve", "ignored-actor")).toMatchObject({ ok: true, approval: { status: "approved", type: "B2C Follow-up" } });
    expect(h.rpcs).toEqual([{ fn: "decide_approval", args: expect.objectContaining({ p_id: A1, p_action: "approve" }) }]);
    expect(writes().filter((c) => c.table !== "agent_activity" && c.table !== "content_items")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the decision itself is logged in the activity history under the b2c agent", async () => {
    h.tables.approvals = [approvalRow()];
    h.rpcResult = () => ({ data: approvalRow({ status: "approved" }), error: null });
    await decideApproval(A1, "approve", "u1");
    expect(inserts("agent_activity")[0].payload).toMatchObject({ agent: "b2c", actor_id: "u1" });
  });

  it("a B2C approval is re-scanned when approved, so an edit that adds a prohibited claim cannot be approved", async () => {
    const bad = "Our pieces are 100% hypoallergenic and guaranteed to cure skin allergies.";
    expect(findProhibitedClaims(bad, []).length).toBeGreaterThan(0);
    h.tables.approvals = [approvalRow({ preview: bad })];
    h.rpcResult = () => ({ data: approvalRow({ status: "approved" }), error: null });
    expect(await decideApproval(A1, "approve", "u1")).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(h.rpcs).toEqual([]);
  });

  it("rejecting is allowed and goes through decide_approval", async () => {
    h.tables.approvals = [approvalRow()];
    h.rpcResult = () => ({ data: approvalRow({ status: "rejected" }), error: null });
    expect(await decideApproval(A1, "reject", "u1", "no consent")).toMatchObject({ ok: true, approval: { status: "rejected" } });
    expect(h.rpcs[0].args).toMatchObject({ p_action: "reject", p_note: "no consent" });
  });
});

describe("M4: the sample demo is unchanged", () => {
  it("in demo mode B2C opportunities are empty, the database is never read, and an unknown sample record is 'not found'", async () => {
    vi.stubEnv("AUTH_MODE", "demo");
    h.calls.length = 0;
    expect(await getB2cOpportunities()).toEqual([]);
    expect(await queueAgentAction("b2c", "does-not-exist")).toMatchObject({ ok: false, reason: "not_found", error: "Record not found." });
    expect(h.calls).toHaveLength(0);
  });
});
