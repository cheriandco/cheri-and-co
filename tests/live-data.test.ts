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
        in: () => q, order: () => q, limit: () => q,
        single: () => { single = true; return q; },
        maybeSingle: () => { single = true; return q; },
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          if (call.op === "insert" && h.insertError) return resolve({ data: null, error: h.insertError });
          const all = h.tables[table] ?? [];
          const rows = call.op === "insert" ? [{ id: "new-1", source: "Manual", status: "open", assignee_id: null, ...call.payload }]
            : all.filter((r) => Object.entries(call.eq).every(([k, v]) => r[k] === v)).map((r) => (call.op === "update" ? { ...r, ...call.payload } : r));
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
  h.calls.length = 0; h.rpcCalls.length = 0; h.insertError = null;
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
    expect(await getRetailers()).toEqual([]);
    expect(await getNotifications()).toEqual([]);
    expect(await getSearchIndex()).toEqual([]);
    expect(await getReports()).toEqual([]);
    expect((await getAmazon()).rows).toEqual([]);
  });
  it("the dashboard and the orchestrator show only live counts and 'not connected' for the rest", async () => {
    const d = await getDashboardSummary();
    expect(d.kpis).toEqual([]); expect(d.retailers).toEqual([]); expect(d.enquiries).toEqual([]);
    expect(d.approvals.map((a) => a.id)).toEqual(["a1"]);
    expect(d.tasks.map((t) => t.id)).toEqual(["t1"]);
    const b = await getOrchestratorBrief();
    expect(b.totals).toEqual({ pending: 1, openTasks: 1, hotLeads: 0 });
    expect(b.agents.find((a) => a.key === "b2b")!.headline).toMatch(/Not connected/);
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
