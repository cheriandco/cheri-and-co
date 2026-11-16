/** M5: Amazon Intelligence through the real route handlers and services, with a recording fake Supabase client (the same approach as m2/m3/m4 tests).
 *  These prove application logic: permissions, CSRF, organisation and environment scoping, demo refusal, approval workflow, no write toward Amazon.
 *  They do NOT prove RLS or the real database (tests/m5-schema-draft.test.ts covers the proposed SQL in PGlite; a hosted run is a later, approved step).
 *  Amazon responses here are DOCUMENTATION-DERIVED fixtures, not Amazon sandbox responses. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
interface Call { table: string; op: string; eq: Row; payload?: unknown; opts?: unknown }
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { table: string; op: string; eq: Record<string, unknown>; payload?: unknown; opts?: unknown }[],
  fault: null as null | ((table: string) => { code?: string; message: string } | null),
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      return { data: { id: "a-1", org_id: "x", title: "T", type: "Amazon insight", generated_by: "amazon", status: "approved", preview: "p", meta: null, created_at: new Date().toISOString() }, error: null };
    },
    from: (table: string) => {
      const call: Call = { table, op: "select", eq: {} };
      h.calls.push(call);
      let single = false;
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (payload: unknown) => { call.op = "insert"; call.payload = payload; return q; },
        update: (payload: unknown) => { call.op = "update"; call.payload = payload; return q; },
        upsert: (payload: unknown, opts: unknown) => { call.op = "upsert"; call.payload = payload; call.opts = opts; return q; },
        eq: (k: string, v: unknown) => { call.eq[k] = v; return q; },
        in: (k: string, v: unknown) => { call.eq[`in:${k}`] = v; return q; },
        gte: () => q, not: () => q, order: () => q, limit: () => q, range: () => q,
        single: () => { single = true; return q; },
        maybeSingle: () => { single = true; return q; },
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          const fault = h.fault?.(table);
          if (fault) return resolve({ data: null, error: fault });
          if (call.op === "insert") return resolve({ data: { id: "new-1", created_at: new Date().toISOString(), ...(call.payload as Row) }, error: null });
          if (call.op === "upsert") return resolve({ data: null, error: null });
          const all = h.tables[table] ?? [];
          const rows = all.filter((r) => Object.entries(call.eq).every(([k, v]) => {
            if (k.startsWith("in:")) return (v as unknown[]).includes(r[k.slice(3)]);
            if (k === "meta->>ref") return (r.meta as Row | null)?.ref === v;
            return r[k] === v;
          }));
          resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
        },
      };
      return q;
    },
  }),
}));

import { GET as connectionGet, POST as connectionPost } from "@/app/api/amazon/connection/route";
import { POST as syncPost } from "@/app/api/amazon/sync/route";
import { POST as generatePost } from "@/app/api/amazon/insights/generate/route";
import { POST as queuePost } from "@/app/api/amazon/insights/[id]/queue/route";
import { GET as insightsGet } from "@/app/api/amazon/insights/route";
import { decideApproval } from "@/services";
import { getAmazonLive, amazonGenerateInsights, amazonSyncStep, amazonVerify } from "@/services/amazon-live";
import { can, PERMISSIONS } from "@/lib/auth/roles";

const ORG = "11111111-1111-4111-8111-111111111111";
const INS = "22222222-2222-4222-8222-222222222222";
const stamp = new Date().toISOString();
const setMembership = (role: string, isDemo = false) => { h.tables.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: isDemo } }]; };
const AMAZON_ENV = { AMAZON_SP_ENVIRONMENT: "sandbox", AMAZON_LWA_CLIENT_ID: "amzn1.application-oa2-client.test", AMAZON_LWA_CLIENT_SECRET: "test-client-secret", AMAZON_SP_REFRESH_TOKEN: "Atzr|test-refresh", AMAZON_SELLER_ID: "A1TESTSELLER" };
const configure = (env: Partial<typeof AMAZON_ENV> = {}) => { for (const [k, v] of Object.entries({ ...AMAZON_ENV, ...env })) vi.stubEnv(k, v); };

const amazonFetch = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.includes("api.amazon.com/auth/o2/token")) return new Response(JSON.stringify({ access_token: "Atza|test-access", expires_in: 3600, token_type: "bearer" }), { status: 200 });
  if (url.includes("/sellers/v1/marketplaceParticipations")) return new Response(readFileSync("tests/fixtures/amazon/marketplace.json", "utf8"), { status: 200 });
  return new Response(JSON.stringify({ errors: [{ code: "NotFound", message: "x" }] }), { status: 404 });
});

const insightRow = (over: Row = {}) => ({ id: INS, org_id: ORG, environment: "production", marketplace_id: "A21TJRUUN4KGV", kind: "low_inventory", severity: "act", title: "Low stock: Ring", summary: "4 units against 30 sold.",
  recommendation: "Consider replenishing SKU-1.", evidence: [{ metric: "Fulfillable units", value: 4, source: "Amazon FBA inventory (synced)" }], dedupe_key: "low_inventory:SKU-1:2026-W46", status: "draft", approval_id: null, created_at: stamp, ...over });

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "required");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  h.calls.length = 0; h.rpcs.length = 0; h.fault = null; amazonFetch.mockClear();
  vi.stubGlobal("fetch", amazonFetch);
  configure();
  h.tables = { approvals: [], agent_activity: [], profiles: [], amazon_insights: [] };
  setMembership("owner");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const headers = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const post = (route: (req: Request, ctx?: never) => Promise<Response>, body: unknown = {}, extra: Record<string, string> = {}) =>
  route(new Request("https://app.test/api/amazon/x", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) }));
const queue = () => queuePost(new Request("https://app.test/api/amazon/insights/x/queue", { method: "POST", headers, body: "{}" }), { params: Promise.resolve({ id: INS }) });
const writes = () => h.calls.filter((c) => c.op !== "select");

describe("permissions", () => {
  it("amazon:sync is owner and admin only; every other permission is unchanged for them", () => {
    expect(PERMISSIONS).toContain("amazon:sync");
    expect((["owner", "admin", "approver", "staff", "viewer"] as const).filter((r) => can(r, "amazon:sync"))).toEqual(["owner", "admin"]);
  });
  for (const role of ["approver", "staff", "viewer"]) {
    it(`${role} cannot verify or sync Amazon and nothing is written or fetched`, async () => {
      setMembership(role);
      expect((await post(connectionPost)).status).toBe(403);
      expect((await post(syncPost, { kind: "orders" })).status).toBe(403);
      expect(amazonFetch).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });
  }
  it("a signed-in account with no membership is refused", async () => {
    h.tables.memberships = [];
    expect((await post(syncPost, { kind: "orders" })).status).toBe(403);
  });
  it("viewers may read the connection but not generate or queue insights", async () => {
    setMembership("viewer");
    expect((await connectionGet()).status).toBe(200);
    expect((await post(generatePost)).status).toBe(403);
    expect((await queue()).status).toBe(403);
  });
  for (const role of ["approver", "staff"]) {
    it(`${role} cannot generate insights (owner/admin only, matching the database) but is offered the send-to-approval action`, async () => {
      setMembership(role);
      expect((await post(generatePost)).status).toBe(403);
      expect(writes().filter((c) => c.table.startsWith("amazon_"))).toHaveLength(0);
      const v = await getAmazonLive();
      expect(v.state === "ready" && [v.canSync, v.canQueue]).toEqual([false, true]);
    });
  }
  it("the service layer enforces the same permissions even if a route forgot to (defence in depth)", async () => {
    setMembership("staff");
    await expect(amazonGenerateInsights()).rejects.toMatchObject({ status: 403 });
    await expect(amazonSyncStep("orders")).rejects.toMatchObject({ status: 403 });
    await expect(amazonVerify()).rejects.toMatchObject({ status: 403 });
    expect(amazonFetch).not.toHaveBeenCalled();
  });
  it("a viewer is offered neither sync nor send-to-approval", async () => {
    setMembership("viewer");
    const v = await getAmazonLive();
    expect(v.state === "ready" && [v.canSync, v.canQueue]).toEqual([false, false]);
  });
  it("owner and admin may verify; the call uses their own session and only the Amazon hosts", async () => {
    for (const role of ["owner", "admin"]) {
      setMembership(role);
      h.calls.length = 0;
      const res = await post(connectionPost);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ ok: true });
      const upsert = h.calls.find((c) => c.table === "amazon_connections" && c.op === "upsert")!;
      expect(upsert.payload).toMatchObject({ org_id: ORG, environment: "sandbox", marketplace_id: "A21TJRUUN4KGV", status: "verified", country_code: "IN" });
    }
    const hosts = new Set(amazonFetch.mock.calls.map((c) => new URL(String(c[0])).hostname));
    expect([...hosts].every((x) => x === "api.amazon.com" || x === "sandbox.sellingpartnerapi-eu.amazon.com")).toBe(true);
  });
  it("blocks cross-site browser writes and rejects bad bodies", async () => {
    expect((await post(syncPost, { kind: "orders" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(syncPost, {})).status).toBe(400);
    expect((await post(syncPost, { kind: "launch_missiles" })).status).toBe(400); // unknown kind never reaches Amazon
    expect(amazonFetch).not.toHaveBeenCalled();
  });
});

describe("demo and configuration", () => {
  it("a demo organisation is refused every Amazon write route and keeps the sample read", async () => {
    setMembership("owner", true);
    expect((await post(connectionPost)).status).toBe(404);
    expect((await post(syncPost, { kind: "orders" })).status).toBe(404);
    expect((await post(generatePost)).status).toBe(404);
    expect((await queue()).status).toBe(404);
    const sample = await (await insightsGet()).json();
    expect(sample).not.toHaveProperty("state");
    expect(h.calls.filter((c) => c.table.startsWith("amazon_"))).toHaveLength(0);
    expect(amazonFetch).not.toHaveBeenCalled();
  });
  it("without credentials it says so, names variables but never values, and calls nothing", async () => {
    vi.stubEnv("AMAZON_LWA_CLIENT_SECRET", "");
    const view = await getAmazonLive();
    expect(view).toMatchObject({ state: "unconfigured" });
    expect(JSON.stringify(view)).toContain("AMAZON_LWA_CLIENT_SECRET");
    expect(JSON.stringify(view)).not.toMatch(/test-client-secret|Atzr/);
    expect((await post(syncPost, { kind: "orders" })).status).toBe(503);
    expect(amazonFetch).not.toHaveBeenCalled();
  });
  it("degrades gracefully when the Amazon tables are not installed", async () => {
    h.fault = (t) => (t.startsWith("amazon_") ? { code: "42P01", message: 'relation "public.amazon_connections" does not exist' } : null);
    expect(await getAmazonLive()).toMatchObject({ state: "tables_missing", environment: "sandbox" });
    const res = await connectionGet();
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("tables_missing");
  });
});

describe("organisation and environment isolation", () => {
  it("every Amazon table query carries the session's organisation and the configured environment, and other rows never appear", async () => {
    h.tables.amazon_insights = [insightRow({ environment: "sandbox", id: "i-mine" }), insightRow({ org_id: "other-org", environment: "sandbox", id: "i-other-org" }), insightRow({ environment: "production", id: "i-prod", dedupe_key: "k2" })];
    const view = await getAmazonLive();
    expect(view.state).toBe("ready");
    if (view.state !== "ready") return;
    expect(view.simulated).toBe(true);
    expect(view.insights.map((i) => i.id)).toEqual(["i-mine"]);
    const amazon = h.calls.filter((c) => c.table.startsWith("amazon_"));
    expect(amazon.length).toBeGreaterThanOrEqual(8);
    for (const c of amazon) { expect(c.eq.org_id, c.table).toBe(ORG); expect(c.eq.environment, c.table).toBe("sandbox"); }
  });
  it("production configuration reads production only", async () => {
    configure({ AMAZON_SP_ENVIRONMENT: "production" });
    h.tables.amazon_insights = [insightRow({ environment: "sandbox", id: "i-sandbox" }), insightRow({ environment: "production", id: "i-prod", dedupe_key: "k2" })];
    const view = await getAmazonLive();
    if (view.state !== "ready") throw new Error("expected ready");
    expect(view.simulated).toBe(false);
    expect(view.insights.map((i) => i.id)).toEqual(["i-prod"]);
  });
  it("the environment cannot be chosen by a request", async () => {
    const res = await post(syncPost, { kind: "orders", environment: "production" });
    expect(res.status).toBe(200); // ignored field; the run is for the configured sandbox
    const run = h.calls.find((c) => c.table === "amazon_sync_runs" && c.op === "insert");
    expect(run).toBeUndefined(); // not verified yet, so nothing started
  });
});

describe("insights and the existing approval workflow", () => {
  it("sandbox insights are refused and create no approval", async () => {
    h.tables.amazon_insights = [insightRow({ environment: "sandbox" })];
    const res = await queue();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/sandbox/i);
    expect(writes().filter((c) => c.table === "approvals")).toHaveLength(0);
  });
  it("a production insight becomes one pending approval with evidence and the no-change note, and is marked submitted", async () => {
    configure({ AMAZON_SP_ENVIRONMENT: "production" });
    h.tables.amazon_insights = [insightRow()];
    const res = await queue();
    expect(res.status).toBe(201);
    const ins = h.calls.find((c) => c.table === "approvals" && c.op === "insert")!;
    const row = ins.payload as Row;
    expect(row).toMatchObject({ org_id: ORG, type: "Amazon insight", generated_by: "amazon", status: "pending" });
    expect(row.meta).toMatchObject({ kind: "amazon_insight", agent: "amazon", ref: INS, environment: "production", allowedClaims: [] });
    expect(String(row.preview)).toContain("Nothing is changed on Amazon.");
    expect(String(row.preview)).toContain("Fulfillable units");
    const mark = h.calls.find((c) => c.table === "amazon_insights" && c.op === "update")!;
    expect(mark.payload).toMatchObject({ status: "submitted" });
    expect(mark.eq).toMatchObject({ org_id: ORG, environment: "production", id: INS });
    expect(amazonFetch).not.toHaveBeenCalled();
  });
  it("refuses a second submission, a dismissed insight and an unknown id", async () => {
    configure({ AMAZON_SP_ENVIRONMENT: "production" });
    h.tables.amazon_insights = [insightRow({ status: "submitted" })];
    expect((await queue()).status).toBe(409);
    h.tables.amazon_insights = [insightRow({ status: "dismissed" })];
    expect((await queue()).status).toBe(409);
    h.tables.amazon_insights = [];
    expect((await queue()).status).toBe(404);
    h.tables.amazon_insights = [insightRow()];
    h.tables.approvals = [{ id: "a1", org_id: ORG, status: "pending", meta: { kind: "amazon_insight", ref: INS } }];
    expect((await queue()).status).toBe(409);
  });
  it("approving records a decision through decide_approval and makes no call to Amazon", async () => {
    h.tables.approvals = [{ id: "a1", org_id: ORG, status: "pending", preview: "Consider replenishing SKU-1.\nApproving records a decision only. Nothing is changed on Amazon.", meta: { kind: "amazon_insight", agent: "amazon", ref: INS, allowedClaims: [] } }];
    const r = await decideApproval("a1", "approve", "u1");
    expect(r.ok).toBe(true);
    expect(h.rpcs).toEqual([{ fn: "decide_approval", args: expect.objectContaining({ p_id: "a1", p_action: "approve" }) }]);
    expect(amazonFetch).not.toHaveBeenCalled();
    expect(writes().filter((c) => c.table.startsWith("amazon_"))).toHaveLength(0);
  });
  it("the claim guard runs on Amazon insights at decision time", async () => {
    h.tables.approvals = [{ id: "a2", org_id: ORG, status: "pending", preview: "Our anti-tarnish coating guarantees results.", meta: { kind: "amazon_insight", agent: "amazon", ref: INS, allowedClaims: [] } }];
    const r = await decideApproval("a2", "approve", "u1");
    expect(r).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(h.rpcs).toHaveLength(0);
  });
  it("generating insights reads synchronised data only and calls nothing external", async () => {
    const res = await post(generatePost);
    expect(res.status).toBe(200);
    expect(amazonFetch).not.toHaveBeenCalled();
    expect(writes().every((c) => c.table === "amazon_insights")).toBe(true);
  });
});

describe("source guards", () => {
  const root = join(process.cwd(), "src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  const amazonFiles = [...walk(join(root, "lib", "amazon")), join(root, "services", "amazon-live.ts"), ...walk(join(root, "app", "api", "amazon")), join(root, "components", "amazon-sync.tsx"), join(root, "components", "amazon-live-view.tsx")];
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const hits = (re: RegExp, files = amazonFiles) => files.filter((f) => re.test(code(f))).map((f) => f.replace(root, "").replaceAll("\\", "/"));

  it("never logs", () => { expect(hits(/console\.(log|info|warn|error|debug)/)).toEqual([]); });
  it("uses no service-role key and no scheduled infrastructure", () => {
    expect(hits(/service_role|SERVICE_ROLE|supabaseAdmin|createClient\(/i)).toEqual([]);
    expect(hits(/setInterval|cron|vercel\.json|waitUntil|unstable_after/i, amazonFiles.filter((f) => !f.endsWith("amazon-sync.tsx")))).toEqual([]);
  });
  it("only the client and LWA modules call fetch, and nothing writes to Amazon beyond createReport", () => {
    const allowed = ["client.ts", "lwa.ts", "amazon-sync.tsx"];
    expect(hits(/\bfetch\(/).filter((f) => !allowed.some((a) => f.endsWith(a)))).toEqual([]);
    expect(hits(/["'](PUT|PATCH|DELETE)["']/, amazonFiles.filter((f) => f.includes("lib")))).toEqual([]);
    // Object-literal POSTs: LWA token exchange and createReport. Everything else toward Amazon is a GET (the client only types "POST" as an option).
    expect(hits(/method:\s*"POST"/, amazonFiles.filter((f) => f.includes(join("lib", "amazon")))).sort()).toEqual(["/lib/amazon/api/reports.ts", "/lib/amazon/lwa.ts"]);
  });
  it("never reads buyer or recipient fields", () => {
    expect(hits(/includedData[^\n]*(BUYER|RECIPIENT)|\.buyer\b|\.recipient\b|buyerEmail|shippingAddress/i, amazonFiles.filter((f) => !f.endsWith("redact.ts")))).toEqual([]);
  });
  it("keeps secrets out of client components", () => {
    expect(hits(/AMAZON_LWA|AMAZON_SP_REFRESH|process\.env/, [join(root, "components", "amazon-sync.tsx"), join(root, "components", "amazon-live-view.tsx")])).toEqual([]);
  });
});
