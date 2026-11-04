/** M3: B2B follow-up drafts queued to Approvals in a live organisation, through the real route handlers and services.
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
import { queueAgentAction, getActionLinks, decideApproval } from "@/services";
import { liveFollowUpDraft } from "@/lib/agent-logic";
import { findProhibitedClaims } from "@/lib/content-agent/claims";

const ORG = "11111111-1111-4111-8111-111111111111";
const R1 = "33333333-3333-4333-8333-333333333333";
const R_OTHER = "66666666-6666-4666-8666-666666666666";
const A1 = "77777777-7777-4777-8777-777777777777";
const A2 = "88888888-8888-4888-8888-888888888888";
const stamp = new Date().toISOString();
const RLS_REFUSAL = { code: "42501", message: "new row violates row-level security policy" };
const setMembership = (role: string, isDemo = false) => { h.tables.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: isDemo } }]; };

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "required");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  h.calls.length = 0; h.insertFault = null; h.inserts = 0; h.rpcs.length = 0; h.rpcResult = null;
  const blank = { category: null, contact: "Priya Shah", email: "priya@aurelia.example", phone: null, instagram: null, website: null, qualification: null, created_at: stamp };
  h.tables = {
    retailers: [{ id: R1, org_id: ORG, business: "Aurelia Boutique", location: "Pune", ...blank },
                { id: R_OTHER, org_id: "other-org", business: "Other Org Shop", location: null, ...blank }],
    leads: [{ id: "l1", org_id: ORG, retailer_id: R1, stage: "negotiation", score: 82, temperature: "HOT", owner_id: null, last_activity_at: stamp }],
    approvals: [], agent_activity: [], profiles: [],
  };
  setMembership("owner");
});
afterEach(() => { vi.unstubAllEnvs(); });

const headers = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const queue = (body: unknown, extra: Record<string, string> = {}) =>
  queueRoute(new Request("https://app.test/api/agent-actions", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) }));
const inserts = (table: string) => h.calls.filter((c) => c.table === table && c.op === "insert");
const writes = () => h.calls.filter((c) => c.op !== "select");
const followMeta = { kind: "b2b_followup", agent: "b2b", ref: R1, isSample: false, allowedClaims: [], subject: "Aurelia Boutique" };
const approvalRow = (over: Row = {}) => ({ id: A1, org_id: ORG, status: "pending", title: "Follow-up email — Aurelia Boutique", type: "B2B outreach", generated_by: "b2b", preview: "Hi Priya,", created_at: stamp, meta: followMeta, ...over });

describe("M3: B2B follow-up reaches Approvals in a live organisation", () => {
  it("queues a pending approval for the signed-in organisation, built on the server from the saved record", async () => {
    const res = await queue({ agent: "b2b", ref: R1, preview: "attacker text", org_id: "other-org" });
    expect(res.status).toBe(201);
    const ins = inserts("approvals");
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toMatchObject({ org_id: ORG, type: "B2B outreach", generated_by: "b2b", status: "pending" });
    const preview = String(ins[0].payload!.preview);
    expect(preview).toContain("Aurelia Boutique");
    expect(preview).toContain("Hi Priya,");
    expect(preview).not.toContain("attacker text");
    expect(ins[0].payload!.meta).toMatchObject({ kind: "b2b_followup", agent: "b2b", ref: R1, isSample: false, allowedClaims: [] });
    expect(await res.json()).toMatchObject({ data: { status: "pending", generatedBy: "b2b", type: "B2B outreach" } });
  });

  it("the live draft is a plain template: no SAMPLE wording, no prices or claims, and it passes the claim scan", () => {
    const d = liveFollowUpDraft({ stage: "new", business: "Aurelia Boutique", temperature: "HOT", contact: "Not recorded", email: "Not recorded" });
    expect(d.preview).not.toMatch(/sample/i);
    expect(d.preview).toContain("Hi there,");
    expect(d.preview).toContain("To: the owner (Aurelia Boutique)");
    expect(d.preview).not.toContain("Not recorded");
    expect(d.preview).not.toMatch(/₹|\$|\d+\s?%/);
    expect(findProhibitedClaims(d.preview, [])).toEqual([]);
    expect(d.title).not.toMatch(/sample/i);
  });

  it("only writes an approval and one activity line; the retailer, its lead and everything else are untouched; no decision is made", async () => {
    await queue({ agent: "b2b", ref: R1 });
    expect([...new Set(writes().map((c) => `${c.table}:${c.op}`))].sort()).toEqual(["agent_activity:insert", "approvals:insert"]);
    expect(h.rpcs).toEqual([]);
  });

  it("records who submitted it in the activity history", async () => {
    await queue({ agent: "b2b", ref: R1 });
    const log = inserts("agent_activity")[0].payload!;
    expect(log).toMatchObject({ org_id: ORG, agent: "b2b", actor_id: "u1" });
    expect(String(log.action)).toContain("Aurelia Boutique");
  });

  it("refuses a duplicate while one is pending (409), but not once it has been decided", async () => {
    h.tables.approvals = [approvalRow()];
    const dup = await queue({ agent: "b2b", ref: R1 });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already waiting/i);
    expect(inserts("approvals")).toHaveLength(0);
    h.tables.approvals[0].status = "rejected";
    expect((await queue({ agent: "b2b", ref: R1 })).status).toBe(201);
  });

  it("another organisation's retailer, an unknown id and a malformed id are 404 and write nothing", async () => {
    for (const ref of [R_OTHER, "99999999-9999-4999-8999-999999999999", "not-a-uuid"]) expect((await queue({ agent: "b2b", ref })).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it("wording that needs a client-approved claim is refused (422) before anything is written", async () => {
    h.tables.retailers[0].business = "100% hypoallergenic guaranteed results store";
    const res = await queue({ agent: "b2b", ref: R1 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/client-approved claims/i);
    expect(writes().filter((c) => c.table === "approvals" || c.table === "agent_activity")).toHaveLength(0);
  });

  it("B2C and Amazon stay refused for a live organisation with a clear message, and write nothing", async () => {
    for (const agent of ["b2c", "amazon"]) {
      const res = await queue({ agent, ref: "anything" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(/not connected to a data source/i);
    }
    expect(writes()).toHaveLength(0);
  });

  it("a viewer is 403, a cross-site request is 403, a bad body is 400; nothing is written", async () => {
    setMembership("viewer");
    expect((await queue({ agent: "b2b", ref: R1 })).status).toBe(403);
    setMembership("staff");
    expect((await queue({ agent: "b2b", ref: R1 }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await queue({ agent: "robot", ref: R1 })).status).toBe(400);
    expect((await queue({ agent: "b2b" })).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it("staff, approver and admin may queue; a database refusal is reported as 403 and leaves no activity line", async () => {
    for (const role of ["staff", "approver", "admin"]) { setMembership(role); expect((await queue({ agent: "b2b", ref: R1 })).status).toBe(201); }
    h.insertFault = (table) => (table === "approvals" ? RLS_REFUSAL : null);
    h.calls.length = 0;
    expect((await queue({ agent: "b2b", ref: R1 })).status).toBe(403);
    expect(inserts("agent_activity")).toHaveLength(0);
  });
});

describe("M3: links, decisions and the claim guard", () => {
  it("getActionLinks reads the newest approval per retailer from the database", async () => {
    h.tables.approvals = [approvalRow({ id: A2, status: "pending" }), approvalRow({ id: A1, status: "approved" })];
    const links = await getActionLinks();
    expect(links).toEqual({ [`b2b:${R1}`]: { approvalId: A2, status: "pending" } });
  });

  it("approving goes through decide_approval, which writes the audit row as the signed-in user; no other table is written", async () => {
    h.tables.approvals = [approvalRow({ preview: "Hi Priya, we would love to share how this could work." })];
    h.rpcResult = () => ({ data: approvalRow({ status: "approved" }), error: null });
    const res = await decideApproval(A1, "approve", "ignored-actor");
    expect(res).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(h.rpcs).toEqual([{ fn: "decide_approval", args: expect.objectContaining({ p_id: A1, p_action: "approve" }) }]);
    expect(writes().filter((c) => c.table !== "agent_activity" && c.table !== "content_items")).toEqual([]);
  });

  it("a B2B approval is scanned at approval time, so an edit that adds a prohibited claim cannot be approved", async () => {
    const bad = "Our pieces are 100% hypoallergenic and guaranteed to cure skin allergies.";
    const flagged = findProhibitedClaims(bad, []).length > 0;
    expect(flagged).toBe(true);
    h.tables.approvals = [approvalRow({ preview: bad })];
    h.rpcResult = () => ({ data: approvalRow({ status: "approved" }), error: null });
    const res = await decideApproval(A1, "approve", "u1");
    expect(res).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(h.rpcs).toEqual([]);
  });

  it("rejecting is not blocked by the scan and also goes through decide_approval", async () => {
    h.tables.approvals = [approvalRow({ preview: "Our pieces are 100% hypoallergenic and guaranteed to cure skin allergies." })];
    h.rpcResult = () => ({ data: approvalRow({ status: "rejected" }), error: null });
    expect(await decideApproval(A1, "reject", "u1", "not now")).toMatchObject({ ok: true, approval: { status: "rejected" } });
    expect(h.rpcs[0].args).toMatchObject({ p_action: "reject", p_note: "not now" });
  });
});

describe("M3: the sample demo is unchanged", () => {
  it("in demo mode nothing touches the database, and an unknown sample record is still 'not found'", async () => {
    vi.stubEnv("AUTH_MODE", "demo");
    h.calls.length = 0;
    expect(await queueAgentAction("b2b", "does-not-exist")).toMatchObject({ ok: false, reason: "not_found" });
    expect(h.calls).toHaveLength(0);
  });
});
