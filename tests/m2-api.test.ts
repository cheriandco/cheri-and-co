/** M2: editing customers and retailers, and CSV import, through the real route handlers and services.
 *  The Supabase client is a recording fake (same approach as tests/live-data.test.ts): these tests prove the application logic
 *  (organisation scoping, permissions, validation, duplicate handling, summaries). They do NOT prove the real database or RLS;
 *  that is what docs/rls_live_check.sql and the staging run are for. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
interface Call { table: string; op: string; eq: Row; payload?: Row; range?: [number, number] }
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as { table: string; op: string; eq: Record<string, unknown>; payload?: Record<string, unknown>; range?: [number, number] }[],
  /** Called for each insert; return an error to make that insert fail. */
  insertFault: null as null | ((table: string, n: number) => { code?: string; message: string } | null),
  inserts: 0,
  updateFault: null as null | (() => { code?: string; message: string } | null),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
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
          if (call.op === "update") {
            const fault = h.updateFault?.();
            if (fault) return resolve({ data: null, error: fault });
          }
          const all = h.tables[table] ?? [];
          const rows = call.op === "insert" ? [{ id: "new-1", source: "Manual", status: "open", assignee_id: null, ...call.payload }]
            : all.filter((r) => Object.entries(call.eq).every(([k, v]) => r[k] === v)).map((r) => (call.op === "update" ? { ...r, ...call.payload } : r));
          const paged = call.range ? rows.slice(call.range[0], call.range[1] + 1) : rows;
          resolve({ data: single ? (rows[0] ?? null) : paged, error: null });
        },
      };
      return q;
    },
  }),
}));

import { POST as importRoute } from "@/app/api/import/[resource]/route";
import { PATCH as patchResource } from "@/app/api/[resource]/[id]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C_OTHER = "55555555-5555-4555-8555-555555555555";
const R1 = "33333333-3333-4333-8333-333333333333";
const R_OTHER = "66666666-6666-4666-8666-666666666666";
const L1 = "44444444-4444-4444-8444-444444444444";
const stamp = new Date().toISOString();
const RLS_REFUSAL = { code: "42501", message: "new row violates row-level security policy" };
const setMembership = (role: string, isDemo = false) => { h.tables.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: isDemo } }]; };

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "required");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  h.calls.length = 0; h.insertFault = null; h.updateFault = null; h.inserts = 0;
  const blank = { phone: null, instagram: null, city: null, interests: null, created_at: stamp };
  const blankRetailer = { category: null, contact: null, email: null, phone: null, instagram: null, website: null, qualification: null, created_at: stamp };
  h.tables = {
    customers: [{ id: C1, org_id: ORG, name: "Meera", email: "meera@example.com", ...blank, instagram: "@meera", city: "Pune", interests: ["saree"] },
                { id: C_OTHER, org_id: "other-org", name: "Not mine", email: "theirs@example.com", ...blank }],
    retailers: [{ id: R1, org_id: ORG, business: "Aurelia Boutique", location: "Pune", ...blankRetailer },
                { id: R_OTHER, org_id: "other-org", business: "Other Org Shop", location: null, ...blankRetailer }],
    leads: [{ id: L1, org_id: ORG, retailer_id: R1, stage: "negotiation", score: 82, temperature: "HOT", owner_id: null, last_activity_at: stamp }],
    orders: [{ id: "o1", org_id: ORG, customer_id: C1, retailer_id: null, channel: "instagram", status: "paid", total: 1499, line_items: [], ordered_at: "2026-11-01T10:00:00.000Z" }],
    tasks: [{ id: "t1", org_id: ORG, title: "Call Asha", source: "Manual", due_at: null, priority: "high", status: "open", assignee_id: null, related_ref: null },
            { id: "t2", org_id: ORG, title: "Old finished job", source: "Manual", due_at: null, priority: "low", status: "done", assignee_id: null, related_ref: null }],
    agent_activity: [], profiles: [],
  };
  setMembership("owner");
});
afterEach(() => { vi.unstubAllEnvs(); });

const headers = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const importCall = (resource: string, csv: string, commit = false, extra: Record<string, string> = {}) =>
  importRoute(new Request(`https://app.test/api/import/${resource}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ csv, commit }) }), { params: Promise.resolve({ resource }) });
const patchRes = (resource: string, id: string, body: unknown) =>
  patchResource(new Request(`https://app.test/api/${resource}/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ resource, id }) });
const inserts = (table: string) => h.calls.filter((c) => c.table === table && c.op === "insert");
const writes = () => h.calls.filter((c) => c.op !== "select");
const HEAD = "name,email,phone,instagram,city,interests\n";

describe("M2: editing customers and retailers", () => {
  it("saves every editable field for this organisation's customer, and never the organisation, id or created_at", async () => {
    const res = await patchRes("customers", C1, { name: "Meera K", city: "Goa", email: "", interests: ["saree", "kurta"], org_id: "attacker-org", id: "x", created_at: "2000-01-01" });
    expect(res.status).toBe(200);
    const upd = h.calls.find((c) => c.table === "customers" && c.op === "update")!;
    expect(upd.eq).toMatchObject({ org_id: ORG, id: C1 });
    expect(upd.payload).toEqual({ name: "Meera K", instagram: null, phone: null, email: null, city: "Goa", interests: ["saree", "kurta"] });
    expect(await res.json()).toMatchObject({ name: "Meera K", city: "Goa" });
  });

  it("another organisation's customer or retailer, or a malformed id, is 404 and nothing is changed", async () => {
    expect((await patchRes("customers", C_OTHER, { name: "Hijack" })).status).toBe(404);
    expect((await patchRes("customers", "not-a-uuid", { name: "x" })).status).toBe(404);
    expect((await patchRes("retailers", R_OTHER, { business: "Hijack" })).status).toBe(404);
    expect(h.tables.customers.find((c) => c.id === C_OTHER)?.name).toBe("Not mine");
  });

  it("edits a retailer's details without touching its lead, and keeps its stage and score", async () => {
    const res = await patchRes("retailers", R1, { business: "Aurelia Boutique", location: "Mumbai", email: "shop@example.com" });
    expect(res.status).toBe(200);
    expect(h.calls.some((c) => c.table === "leads" && c.op === "update")).toBe(false);
    expect(h.calls.find((c) => c.table === "retailers" && c.op === "update")!.payload).toMatchObject({ business: "Aurelia Boutique", location: "Mumbai", email: "shop@example.com", website: null });
    expect(await res.json()).toMatchObject({ location: "Mumbai", stage: "negotiation", score: 82 });
  });

  it("invalid edits are 400 and a viewer is 403; the database is not written to in either case", async () => {
    expect((await patchRes("customers", C1, { name: "" })).status).toBe(400);
    expect((await patchRes("retailers", R1, { business: "" })).status).toBe(400);
    setMembership("viewer");
    expect((await patchRes("customers", C1, { name: "x" })).status).toBe(403);
    expect((await patchRes("retailers", R1, { business: "x" })).status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("a database refusal is a 403, not a 500", async () => {
    h.updateFault = () => RLS_REFUSAL;
    expect((await patchRes("customers", C1, { name: "x" })).status).toBe(403);
    expect((await patchRes("retailers", R1, { business: "x" })).status).toBe(403);
  });
});

describe("M2: CSV import", () => {
  it("a preview saves nothing and reports ready, duplicate and invalid rows with their line numbers", async () => {
    const res = await importCall("customers", `${HEAD}Asha,asha@example.com,,,Pune,earrings\nMeera Again,MEERA@example.com,,,,\n,x@y.com,,,,\nBad,nope,,,,\n`);
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(report.counts).toEqual({ total: 4, valid: 1, duplicate: 1, invalid: 2 });
    expect(report.rows.map((r: { line: number; status: string }) => [r.line, r.status])).toEqual([[2, "valid"], [3, "duplicate"], [4, "invalid"], [5, "invalid"]]);
    expect(writes()).toEqual([]);
  });

  it("an import saves only the valid, new rows for the session's organisation, with one summary line instead of one per row", async () => {
    const csv = `${HEAD}Asha,asha@example.com,,,Pune,earrings; rings\nRiya,riya@example.com,,,,\nMeera Again,meera@example.com,,,,\nBad,nope,,,,\n`;
    const res = await importCall("customers", csv, true);
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ created: 2, failed: [], report: { counts: { valid: 2, duplicate: 1, invalid: 1 } } });
    const saved = inserts("customers").map((c) => c.payload);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ org_id: ORG, name: "Asha", email: "asha@example.com", interests: ["earrings", "rings"] });
    expect(inserts("agent_activity").map((c) => (c.payload as { action: string }).action)).toEqual(["Imported 2 customers from a CSV file"]);
  });

  it("the server re-checks the file when importing: invalid and duplicate rows are never saved, whatever the preview said", async () => {
    await importCall("customers", `${HEAD}Meera Dup,meera@example.com,,,,\nNo email bad,not-an-email,,,,\n`, true);
    expect(inserts("customers")).toEqual([]);
  });

  it("an organisation column in the file is ignored: the organisation is always the session's", async () => {
    const out = await (await importCall("customers", "name,org_id\nAsha,attacker-org\n", true)).json();
    expect(out.report.warnings.join(" ")).toMatch(/Ignored columns.*org_id/);
    expect(inserts("customers")[0].payload).toMatchObject({ org_id: ORG });
    expect(JSON.stringify(inserts("customers")[0].payload)).not.toContain("attacker-org");
  });

  it("a row the database refuses is reported with its line and the other rows are still saved", async () => {
    h.insertFault = (table, n) => (table === "customers" && n === 2 ? RLS_REFUSAL : null);
    const out = await (await importCall("customers", `${HEAD}One,one@example.com,,,,\nTwo,two@example.com,,,,\nThree,three@example.com,,,,\n`, true)).json();
    expect(out.created).toBe(2);
    expect(out.failed).toEqual([{ line: 3, label: "Two", error: "You do not have permission to do this" }]);
  });

  it("an unexpected database failure on a row is a generic message, not the raw error", async () => {
    h.insertFault = () => ({ code: "XX000", message: "relation \"secret_internal\" exploded" });
    const out = await (await importCall("customers", `${HEAD}One,one@example.com,,,,\n`, true)).json();
    expect(out.created).toBe(0);
    expect(out.failed).toEqual([{ line: 2, label: "One", error: "Could not save this row." }]);
    expect(JSON.stringify(out)).not.toContain("secret_internal");
  });

  it("header problems stop the import before any row is read as data", async () => {
    const out = await (await importCall("customers", "email\nx@y.com\n", true)).json();
    expect(out.created).toBe(0);
    expect(out.report.headerErrors).toEqual(["Required column “name” is missing."]);
    expect(writes()).toEqual([]);
  });

  it("retailers: each valid row creates the retailer and its first lead, and an existing business in the same place is a duplicate", async () => {
    const out = await (await importCall("retailers", "business,location,email\nAurelia Boutique,Pune,\nNew Boutique,Goa,new@example.com\n", true)).json();
    expect(out).toMatchObject({ created: 1, report: { counts: { valid: 1, duplicate: 1 } } });
    expect(inserts("retailers")).toHaveLength(1);
    expect(inserts("leads")[0].payload).toMatchObject({ org_id: ORG, stage: "new" });
    expect(inserts("agent_activity").map((c) => (c.payload as { action: string }).action)).toEqual(["Imported 1 retailers from a CSV file"]);
  });

  it("tasks: validates priority and due, skips an OPEN task with the same title (but not a finished one), and saves the rest as manual tasks", async () => {
    const out = await (await importCall("tasks", "title,priority,due\nCall Asha,high,Tomorrow\nOld finished job,low,\nNew follow-up,low,2026-12-01\nBad one,urgent,\n", true)).json();
    expect(out).toMatchObject({ created: 2, report: { counts: { valid: 2, duplicate: 1, invalid: 1 } } });
    const saved = inserts("tasks").map((c) => c.payload as { title: string; priority: string; source: string; due_at: string | null; org_id: string });
    expect(saved.map((s) => s.title)).toEqual(["Old finished job", "New follow-up"]);
    expect(saved[1]).toMatchObject({ org_id: ORG, priority: "low", source: "Manual" });
    expect(String(saved[1].due_at)).toMatch(/^2026-12-01T/);
    expect(saved[0].due_at).toBeNull();
  });

  it("orders: customers are found by email within this organisation, unknown emails are rejected, and an existing order is a duplicate", async () => {
    const csv = "channel,total,status,ordered_at,customer_email\ninstagram,\"₹2,500\",paid,2026-11-05,meera@example.com\ninstagram,10,,,nobody@example.com\ninstagram,1499,paid,2026-11-01,meera@example.com\n";
    const out = await (await importCall("orders", csv, true)).json();
    expect(out).toMatchObject({ created: 1, report: { counts: { valid: 1, duplicate: 1, invalid: 1 } } });
    expect(inserts("orders")[0].payload).toMatchObject({ org_id: ORG, customer_id: C1, channel: "instagram", status: "paid", total: 2500 });
    expect(out.report.rows[1].errors[0]).toMatch(/No existing customer/);
  });

  it("an order row cannot be matched to another organisation's customer or retailer", async () => {
    const out = await (await importCall("orders", "channel,total,customer_email,retailer_business\ninstagram,10,theirs@example.com,\nb2b,10,,Other Org Shop\n")).json();
    expect(out.report.counts).toMatchObject({ valid: 0, invalid: 2 });
  });

  it("every resource needs the same permission as creating one record by hand: a viewer is refused everywhere and nothing is written", async () => {
    setMembership("viewer");
    for (const r of ["customers", "retailers", "tasks", "orders"]) {
      expect((await importCall(r, "name\nx\n")).status, r).toBe(403);
      expect((await importCall(r, "name\nx\n", true)).status, r).toBe(403);
    }
    expect(writes()).toEqual([]);
    setMembership("staff");
    expect((await importCall("customers", `${HEAD}Zed,,,,,\n`)).status).toBe(200);
  });

  it("a cross-site request is refused, an unknown resource is 404, and a body without csv is 400", async () => {
    expect((await importCall("customers", `${HEAD}A,,,,,\n`, true, { origin: "https://evil.example" })).status).toBe(403);
    expect((await importCall("products", "sku\nx\n")).status).toBe(404);
    const bad = await importRoute(new Request("https://app.test/api/import/customers", { method: "POST", headers, body: JSON.stringify({ commit: true }) }), { params: Promise.resolve({ resource: "customers" }) });
    expect(bad.status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("the sample demo cannot import: 404, nothing written", async () => {
    setMembership("owner", true);
    expect((await importCall("customers", `${HEAD}A,,,,,\n`, true)).status).toBe(404);
    expect((await importCall("tasks", "title\nA\n", true)).status).toBe(404);
    expect(writes()).toEqual([]);
  });
});
