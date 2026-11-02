/** Authentication and authorization. The Supabase server client is replaced with a fake, so every layer above it
 *  (session mapping, permissions, tenancy, route guards, data-layer check, proxy) runs for real. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Fake { user: { id: string; email: string } | null; rows: unknown[]; claims?: { sub: string } | null }
const g = vi.hoisted(() => ({ fake: { user: null, rows: [] } as { user: { id: string; email: string } | null; rows: unknown[]; claims?: { sub: string } | null } }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    const f = g.fake as Fake;
    // only the memberships lookup returns rows; every other table is empty (a brand-new live organisation)
    const make = (table: string) => {
      const data = table === "memberships" ? f.rows : [];
      const query: Record<string, unknown> = {
        select: () => query, eq: () => query, not: () => query, in: () => query, order: () => query,
        limit: () => query, range: () => query, maybeSingle: () => query,
        then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data, error: null }),
      };
      return query;
    };
    return { auth: { getUser: async () => (f.user ? { data: { user: f.user }, error: null } : { data: { user: null }, error: { message: "no session" } }) }, from: make };
  },
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: (g.fake as Fake).claims ?? null } }) } }),
}));

import { csrfProblem, deny, requireAccess, AuthError } from "@/lib/auth/access";
import { safeNext, isPublicPage } from "@/lib/auth/paths";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { proxy } from "@/proxy";
import { readStore } from "@/services/store";

const member = (role: string, isDemo = true) => [{ org_id: "o1", role, organizations: { is_demo: isDemo } }];
const signIn = (rows: unknown[] = member("owner")) => { g.fake = { user: { id: "u1", email: "u1@test.invalid" }, rows, claims: { sub: "u1" } }; };

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "required");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  g.fake = { user: null, rows: [], claims: null };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("modes", () => {
  it("demo is the default and stays open", async () => {
    vi.stubEnv("AUTH_MODE", "");
    expect((await requireAccess("approvals:decide")).id).toBe("demo");
    expect(await deny("data:read")).toBeNull();
    expect((await proxy(new NextRequest("https://x.test/dashboard"))).status).toBe(200);
  });
  it("anything but the exact word 'required' is demo", async () => {
    vi.stubEnv("AUTH_MODE", "Required ");
    expect((await getAuthUser())?.id).toBe("demo");
  });
});

describe("required mode: who gets in", () => {
  it("rejects signed-out callers with 401", async () => {
    const res = await deny("data:read");
    expect(res?.status).toBe(401);
  });
  it("fails closed when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    await expect(requireAccess("data:read")).rejects.toMatchObject({ status: 401 });
  });
  it("a signed-in account with no membership can do nothing", async () => {
    signIn([]);
    expect((await getAuthUser())?.role).toBeNull();
    await expect(requireAccess("data:read")).rejects.toMatchObject({ status: 403 });
  });
  it("viewers read but cannot write or decide", async () => {
    signIn(member("viewer"));
    await expect(requireAccess("data:read")).resolves.toBeTruthy();
    for (const p of ["tasks:write", "pipeline:write", "agents:run", "content:submit", "approvals:decide"] as const)
      await expect(requireAccess(p)).rejects.toBeInstanceOf(AuthError);
  });
  it("staff write but cannot decide approvals; approvers can", async () => {
    signIn(member("staff"));
    await expect(requireAccess("tasks:write")).resolves.toBeTruthy();
    await expect(requireAccess("approvals:decide")).rejects.toMatchObject({ status: 403 });
    signIn(member("approver"));
    await expect(requireAccess("approvals:decide")).resolves.toBeTruthy();
  });
  it("a live organisation passes access checks and reads its own data, not the sample store", async () => {
    signIn(member("owner", false));
    await expect(requireAccess("data:read")).resolves.toBeTruthy();
    expect((await readStore()).retailers).toEqual([]); // empty, never the 6 sample retailers
  });
  it("an unknown role string grants nothing", async () => {
    signIn(member("superadmin"));
    expect((await getAuthUser())?.role).toBeNull();
    await expect(requireAccess("data:read")).rejects.toMatchObject({ status: 403 });
  });
  it("the data layer refuses signed-out readers", async () => {
    await expect(readStore()).rejects.toMatchObject({ status: 401 });
  });
  it("roles matrix matches the database policy (write = owner/admin/approver/staff, decide = owner/admin/approver)", () => {
    expect(can("staff", "approvals:decide")).toBe(false);
    expect(can("approver", "approvals:decide")).toBe(true);
    expect(can("viewer", "data:read")).toBe(true);
    expect(can(null, "data:read")).toBe(false);
  });
});

describe("csrf", () => {
  const post = (headers: Record<string, string>) => new Request("https://app.test/api/x", { method: "POST", headers: { host: "app.test", ...headers } });
  it("blocks cross-site and non-JSON browser writes; allows same-site JSON and header-less clients", () => {
    expect(csrfProblem(post({ origin: "https://evil.test", "content-type": "application/json" }))).toMatch(/Cross-site/);
    expect(csrfProblem(post({ origin: "https://app.test", "content-type": "text/plain" }))).toMatch(/Content-Type/);
    expect(csrfProblem(post({ origin: "null", "content-type": "application/json" }))).toMatch(/Cross-site/);
    expect(csrfProblem(post({ origin: "https://app.test", "content-type": "application/json" }))).toBeNull();
    expect(csrfProblem(post({}))).toBeNull();
  });
  it("is enforced by deny() in required mode", async () => {
    signIn();
    const res = await deny("tasks:write", new Request("https://app.test/api/x", { method: "POST", headers: { host: "app.test", origin: "https://evil.test", "content-type": "application/json" } }));
    expect(res?.status).toBe(403);
  });
});

describe("proxy", () => {
  it("sends signed-out visitors to /login and keeps the page they wanted", async () => {
    const res = await proxy(new NextRequest("https://x.test/approvals?tab=a"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(res.headers.get("location")).toContain("next=%2Fapprovals%3Ftab%3Da");
  });
  it("answers signed-out API calls with 401, not a redirect", async () => {
    expect((await proxy(new NextRequest("https://x.test/api/tasks"))).status).toBe(401);
  });
  it("lets /login through, and bounces signed-in users off it", async () => {
    expect((await proxy(new NextRequest("https://x.test/login"))).status).toBe(200);
    signIn();
    expect(new URL((await proxy(new NextRequest("https://x.test/login"))).headers.get("location")!).pathname).toBe("/dashboard");
    expect((await proxy(new NextRequest("https://x.test/dashboard"))).status).toBe(200);
  });
  it("fails closed when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect((await proxy(new NextRequest("https://x.test/dashboard"))).status).toBe(307);
  });
});

describe("redirect safety", () => {
  it("only same-site relative paths survive", () => {
    expect(safeNext("/approvals")).toBe("/approvals");
    for (const bad of ["//evil.test", "https://evil.test", "/\\evil", "javascript:alert(1)", "/login", undefined, 5, "/a\nb"])
      expect(safeNext(bad)).toBe("/dashboard");
    expect(isPublicPage("/login")).toBe(true);
    expect(isPublicPage("/dashboard")).toBe(false);
  });
});

describe("static guarantees", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
  const read = (p: string) => readFileSync(p, "utf8");

  it("every API route handler checks access first", () => {
    const routes = files("src/app/api").filter((p) => p.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(10);
    for (const r of routes) {
      const src = read(r);
      const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\(/g)].length;
      const guards = [...src.matchAll(/await deny\(/g)].length;
      expect(guards, r).toBe(handlers);
    }
  });
  it("the service-role key is read in exactly one server-only file and never in client code", () => {
    const all = files("src").filter((p) => /\.(ts|tsx)$/.test(p));
    const using = all.filter((p) => read(p).includes("SUPABASE_SERVICE_ROLE_KEY"));
    expect(using.map((p) => p.replace(/\\/g, "/"))).toEqual(["src/lib/supabase/admin.ts"]);
    for (const p of all.filter((f) => /^"use client"/.test(read(f)))) {
      expect(read(p), p).not.toMatch(/service_role|SERVICE_ROLE|supabase\/admin/);
    }
    expect(all.filter((p) => /NEXT_PUBLIC_[A-Z_]*SERVICE/.test(read(p)))).toEqual([]);
  });
  it(".env.example documents the variables and contains no values", () => {
    const env = read(".env.example");
    for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "AUTH_MODE"]) expect(env).toContain(k);
    expect(env).toMatch(/^AUTH_MODE=demo$/m);
    for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"]) expect(env).toMatch(new RegExp(`^${k}=$`, "m"));
  });
  it("no JWT or Supabase key is committed in source, docs, migrations or env example", () => {
    const targets = [...files("src"), ...files("supabase"), ...files("docs"), ".env.example"];
    for (const p of targets) expect(read(p), p).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sb_secret_|sb_publishable_[A-Za-z0-9]{10,}/);
  });
  it("the migration enables RLS on every table it creates and has no data inserts", () => {
    const sql = read("supabase/migrations/20261101000000_foundation.sql").replace(/--.*$/gm, "");
    const created = [...sql.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]);
    expect(created.length).toBe(13);
    for (const t of created) expect(sql, t).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    // Only the two functions may insert (profile on sign-up, audit row on a decision); no seed or sample rows.
    const inserts = [...sql.matchAll(/insert into public\.(\w+)/gi)].map((m) => m[1]).sort();
    expect(inserts).toEqual(["audit_log", "profiles"]);
  });
});
