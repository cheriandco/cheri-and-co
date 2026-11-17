/** M5 approval hardening: the proposed trigger on public.approvals (docs/M5_APPROVAL_HARDENING.md).
 *  Loaded on top of the real foundation migration and the local Amazon migration in an in-process Postgres. The guard SQL is read from the proposal
 *  document, so what is tested is what is proposed. NOTHING here is applied to Supabase; this proves the SQL, not the hosted service. */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const U = {
  ownerA: "11111111-0000-0000-0000-000000000001", approverA: "11111111-0000-0000-0000-000000000004", staffA: "11111111-0000-0000-0000-000000000002",
  viewerA: "11111111-0000-0000-0000-000000000003", ownerB: "22222222-0000-0000-0000-000000000001",
};
const INS = {
  prodA: "cccccccc-0000-0000-0000-00000000000a", sandboxA: "cccccccc-0000-0000-0000-00000000000b", prodB: "cccccccc-0000-0000-0000-00000000000c",
  sandboxB: "cccccccc-0000-0000-0000-00000000000d",
};
const MISSING = "cccccccc-0000-0000-0000-0000000000ff";

const stub = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

function guardSql(): string {
  const doc = readFileSync("docs/M5_APPROVAL_HARDENING.md", "utf8").replace(/\r\n/g, "\n");
  const m = doc.match(/## 3\. Proposed SQL\n\n```sql\n([\s\S]*?)\n```/);
  if (!m) throw new Error("Proposed SQL block not found in docs/M5_APPROVAL_HARDENING.md");
  return m[1];
}

let db: PGlite;
async function as<T>(sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.sub', '${sub ?? ""}', false); set role ${sub ? "authenticated" : "anon"};`);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.sub', '', false);"); }
}
const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
const fails = async (sql: string) => { try { await db.query(sql); return null; } catch (e) { return (e as Error).message; } };

let n = 0;
const lit = (v: unknown) => (v === null ? "null" : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`);
/** An approval insert. `meta` defaults to a well-formed Amazon insight reference. */
function approval(org: string, meta: unknown, generatedBy = "amazon", type = "Amazon insight") {
  return `insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('${org}', 'a${++n}', '${type}', '${generatedBy}', 'p', ${lit(meta)})`;
}
const ref = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "amazon_insight", agent: "amazon", ref: id, ...extra });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(stub);
  await db.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20261111000000_amazon_intelligence.sql", "utf8"));
  // Emulate hosted default privileges for functions created in `private` from here on, so the guard function starts out executable by these roles
  // and the revoke in the proposal is what removes it. Without this the privilege tests would pass even with no revoke at all.
  await db.exec("alter default privileges in schema private grant execute on functions to anon, authenticated, service_role");
  await db.exec(guardSql());
  const insight = (id: string, org: string, env: string, key: string) =>
    `insert into public.amazon_insights (id, org_id, environment, marketplace_id, kind, severity, title, summary, recommendation, evidence, dedupe_key)
     values ('${id}', '${org}', '${env}', 'A21TJRUUN4KGV', 'low_inventory', 'act', 't', 's', 'r', '[{"metric":"fulfillable","value":2}]', '${key}')`;
  await db.exec(`
    insert into auth.users (id, raw_user_meta_data) values ${Object.values(U).map((id) => `('${id}', '{}')`).join(",")};
    insert into public.organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into public.memberships (org_id, user_id, role) values
      ('${ORG_A}', '${U.ownerA}', 'owner'), ('${ORG_A}', '${U.approverA}', 'approver'), ('${ORG_A}', '${U.staffA}', 'staff'),
      ('${ORG_A}', '${U.viewerA}', 'viewer'), ('${ORG_B}', '${U.ownerB}', 'owner');
    ${insight(INS.prodA, ORG_A, "production", "pa")};
    ${insight(INS.sandboxA, ORG_A, "sandbox", "sa")};
    ${insight(INS.prodB, ORG_B, "production", "pb")};
    ${insight(INS.sandboxB, ORG_B, "sandbox", "sb")};
  `);
});
afterAll(async () => { await db.close(); });

describe("approval guard: a valid production insight", () => {
  it("can be queued by every role that may queue approvals, in its own organisation", async () => {
    for (const u of [U.ownerA, U.approverA, U.staffA]) await as(u, () => db.query(approval(ORG_A, ref(INS.prodA))));
    expect((await rows(`select count(*)::int as n from public.approvals where meta ->> 'ref' = '${INS.prodA}'`))[0].n).toBe(3);
  });
  it("can still be linked from the insight and decided through decide_approval, which writes the audit row", async () => {
    const id = (await rows(`select id from public.approvals where meta ->> 'ref' = '${INS.prodA}' limit 1`))[0].id as string;
    await as(U.staffA, () => db.query(`update public.amazon_insights set status = 'submitted', approval_id = '${id}' where id = '${INS.prodA}'`));
    expect(await as(U.staffA, () => fails(`select public.decide_approval('${id}', 'approve')`))).toMatch(/not authorized/);
    await as(U.approverA, () => db.query(`select public.decide_approval('${id}', 'approve')`));
    expect((await rows(`select actor_id from public.audit_log where approval_id = '${id}'`))[0].actor_id).toBe(U.approverA);
  });
  it("is accepted with extra meta fields (environment, agent, notes)", async () => {
    await as(U.ownerA, () => db.query(approval(ORG_A, ref(INS.prodA, { environment: "production", note: "x" }))));
  });
  it("is refused when generated_by is not amazon", async () => {
    for (const g of ["b2c", "b2b", "content", "crm"]) expect(await as(U.ownerA, () => fails(approval(ORG_A, ref(INS.prodA), g))), g).toMatch(/must be generated_by amazon/);
  });
});

describe("approval guard: sandbox insights", () => {
  it("are refused for every role, including a statement with no signed-in user", async () => {
    for (const u of [U.ownerA, U.approverA, U.staffA]) expect(await as(u, () => fails(approval(ORG_A, ref(INS.sandboxA)))), u).toMatch(/sandbox Amazon insights cannot be queued/);
    expect(await fails(approval(ORG_A, ref(INS.sandboxA)))).toMatch(/sandbox Amazon insights cannot be queued/);
  });
  it("are not rescued by a meta that claims production: the insight row decides, not the request", async () => {
    expect(await as(U.ownerA, () => fails(approval(ORG_A, ref(INS.sandboxA, { environment: "production" }))))).toMatch(/sandbox Amazon insights cannot be queued/);
  });
  it("cannot be turned into a production one afterwards (the scope trigger refuses the relabel)", async () => {
    expect(await as(U.ownerA, () => fails(`update public.amazon_insights set environment = 'production' where id = '${INS.sandboxA}'`))).toMatch(/cannot be changed/);
  });
  it("leave no approval row behind", async () => {
    expect((await rows(`select count(*)::int as n from public.approvals where meta ->> 'ref' in ('${INS.sandboxA}', '${INS.sandboxB}')`))[0].n).toBe(0);
  });
});

describe("approval guard: organisation ownership", () => {
  it("another organisation's production insight is refused, and the answer is the same as for a missing insight", async () => {
    const cross = await as(U.ownerA, () => fails(approval(ORG_A, ref(INS.prodB))));
    const missing = await as(U.ownerA, () => fails(approval(ORG_A, ref(MISSING))));
    expect(cross).toMatch(/Amazon insight not found in this organisation/);
    expect(cross).toBe(missing); // no hint that the insight exists elsewhere
  });
  it("works in both directions, and for another organisation's sandbox insight (reported as not found, not as sandbox)", async () => {
    expect(await as(U.ownerB, () => fails(approval(ORG_B, ref(INS.prodA))))).toMatch(/not found in this organisation/);
    expect(await as(U.ownerA, () => fails(approval(ORG_A, ref(INS.sandboxB))))).toMatch(/not found in this organisation/);
    await as(U.ownerB, () => db.query(approval(ORG_B, ref(INS.prodB)))); // each organisation can queue its own
  });
  it("a caller cannot queue into another organisation at all (the foundation policy still applies first)", async () => {
    expect(await as(U.ownerA, () => fails(approval(ORG_B, ref(INS.prodB))))).toMatch(/row-level security/);
  });
  it("the viewer role and a non-member still cannot queue anything (foundation policy unchanged)", async () => {
    expect(await as(U.viewerA, () => fails(approval(ORG_A, ref(INS.prodA))))).toMatch(/row-level security/);
    expect(await as(null, () => fails(approval(ORG_A, ref(INS.prodA))))).toMatch(/permission denied/);
  });
});

describe("approval guard: missing or malformed references", () => {
  it("an insight that does not exist is refused", async () => {
    expect(await as(U.ownerA, () => fails(approval(ORG_A, ref(MISSING))))).toMatch(/not found in this organisation/);
  });
  it("a deleted insight is refused", async () => {
    await db.exec(`insert into public.amazon_insights (id, org_id, environment, marketplace_id, kind, severity, title, summary, recommendation, evidence, dedupe_key)
      values ('cccccccc-0000-0000-0000-0000000000e1', '${ORG_A}', 'production', 'A21TJRUUN4KGV', 'low_inventory', 'act', 't', 's', 'r', '[{"metric":"x"}]', 'gone')`);
    await db.exec("delete from public.amazon_insights where id = 'cccccccc-0000-0000-0000-0000000000e1'");
    expect(await as(U.ownerA, () => fails(approval(ORG_A, ref("cccccccc-0000-0000-0000-0000000000e1"))))).toMatch(/not found in this organisation/);
  });
  it("a missing, empty, non-string or non-UUID ref is refused without a cast error", async () => {
    const metas: unknown[] = [
      { kind: "amazon_insight" }, { kind: "amazon_insight", ref: "" }, { kind: "amazon_insight", ref: null }, { kind: "amazon_insight", ref: 12345 },
      { kind: "amazon_insight", ref: "not-a-uuid" }, { kind: "amazon_insight", ref: `${INS.prodA}; drop table x` }, { kind: "amazon_insight", ref: [INS.prodA] },
      { kind: "amazon_insight", ref: { id: INS.prodA } },
    ];
    for (const m of metas) expect(await as(U.ownerA, () => fails(approval(ORG_A, m))), JSON.stringify(m)).toMatch(/reference is missing or invalid/);
  });
  it("a ref in upper case is accepted when it names a real production insight", async () => {
    await as(U.ownerA, () => db.query(approval(ORG_A, ref(INS.prodA.toUpperCase()))));
  });
});

describe("approval guard: other agents are unaffected", () => {
  it("rows with no meta, or a different kind, or no kind, insert exactly as before", async () => {
    const cases: [unknown, string, string][] = [
      [null, "b2c", "Reorder"], [{}, "b2b", "Retailer outreach"], [{ kind: "content" }, "content", "Content"], [{ kind: "social_post", ref: "whatever" }, "content", "Social"],
      [{ ref: MISSING }, "crm", "Follow-up"], [{ kind: "amazon" }, "amazon", "Amazon action"], [null, "amazon", "Amazon action"], [{ kind: "Amazon_Insight", ref: "x" }, "amazon", "x"],
      [{ kind: ["amazon_insight"] }, "b2c", "x"], [{ kind: null, ref: "x" }, "b2c", "x"],
    ];
    for (const [meta, g, type] of cases) await as(U.staffA, () => db.query(approval(ORG_A, meta, g, type)));
  });
  it("the trigger only fires for the Amazon insight kind: the function is guarded by a WHEN clause", async () => {
    const def = (await rows("select pg_get_triggerdef(oid) as d from pg_trigger where tgname = 'approvals_amazon_guard'"))[0].d as string;
    expect(def).toMatch(/BEFORE INSERT ON public\.approvals/i);
    expect(def).toMatch(/WHEN/i);
    expect(def).toMatch(/amazon_insight/);
    expect(def).not.toMatch(/UPDATE|DELETE/i);
  });
  it("the foundation rules for the status check and for the size limits still apply to an Amazon insight approval", async () => {
    expect(await as(U.ownerA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, status, preview, meta) values ('${ORG_A}', 't', 'Amazon insight', 'amazon', 'approved', 'p', ${lit(ref(INS.prodA))})`))).toMatch(/row-level security/);
    expect(await as(U.ownerA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('${ORG_A}', '${"x".repeat(201)}', 'Amazon insight', 'amazon', 'p', ${lit(ref(INS.prodA))})`))).toMatch(/check constraint/);
  });
});

describe("approval guard: exact footprint on the existing approvals table", () => {
  it("columns, policies and grants are exactly what the foundation created", async () => {
    expect((await rows("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'approvals' order by ordinal_position")).map((r) => r.column_name))
      .toEqual(["id", "org_id", "title", "type", "generated_by", "status", "preview", "meta", "created_at"]);
    expect((await rows("select policyname, cmd from pg_policies where tablename = 'approvals' order by 1")).map((r) => `${r.policyname}:${r.cmd}`)).toEqual(["approvals_insert:INSERT", "approvals_read:SELECT"]);
    expect((await rows("select privilege_type from information_schema.role_table_grants where table_name = 'approvals' and grantee = 'authenticated' order by 1")).map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });
  it("the only trigger on approvals is the proposed one, and the only added function is private.amazon_approval_guard", async () => {
    expect((await rows("select tgname from pg_trigger where tgrelid = 'public.approvals'::regclass and not tgisinternal")).map((r) => r.tgname)).toEqual(["approvals_amazon_guard"]);
    expect((await rows("select proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'private' and proname like '%approval%'")).map((r) => r.proname)).toEqual(["amazon_approval_guard"]);
  });
  it("authenticated and anon cannot call the guard function directly", async () => {
    expect(await as(U.ownerA, () => fails("select private.amazon_approval_guard()"))).toMatch(/permission denied|trigger functions can only be called as triggers/);
  });
  it("EXECUTE is revoked from public, anon, authenticated and service_role (no grantee at all, including the PUBLIC default)", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await rows(`select has_function_privilege('${role}', 'private.amazon_approval_guard()', 'execute') as ok`))[0].ok, role).toBe(false);
    }
    // proacl is non-null (the default PUBLIC grant was replaced) and no ACL entry grants EXECUTE to anyone but the owner
    const acl = await rows(`select a.grantee::regrole::text as grantee from pg_proc p, aclexplode(p.proacl) a where p.oid = 'private.amazon_approval_guard()'::regprocedure`);
    expect(acl.length).toBeGreaterThan(0);
    expect(acl.map((r) => r.grantee)).not.toContain("-"); // grantee 0 is PUBLIC
    for (const role of ["anon", "authenticated", "service_role"]) expect(acl.map((r) => r.grantee), role).not.toContain(role);
  });
  it("service_role cannot call it directly either", async () => {
    await db.exec("set role service_role");
    try { expect(await fails("select private.amazon_approval_guard()")).toMatch(/permission denied/); } finally { await db.exec("reset role"); }
  });
  it("the proposal text itself revokes from all four and uses IS DISTINCT FROM for both comparisons", () => {
    const sql = guardSql();
    expect(sql).toMatch(/revoke all on function private\.amazon_approval_guard\(\) from public, anon, authenticated, service_role;/);
    expect(sql).toMatch(/new\.generated_by is distinct from 'amazon'/);
    expect(sql).toMatch(/env is distinct from 'production'/);
    expect(sql).not.toMatch(/generated_by\s*<>|env\s*<>/);
  });
  it("the proposal SQL is forward-only and touches no other object", () => {
    const sql = guardSql().replace(/--[^\n]*/g, ""); // statements only, not comments
    expect(sql).not.toMatch(/\b(drop|truncate|alter\s+table|create\s+table|create\s+policy|grant\s)/i);
    expect(sql).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s/i);
    expect(sql.match(/create (or replace )?(function|trigger)/gi)).toHaveLength(2);
  });
  it("the Amazon migration itself is unchanged by this proposal: it does not mention the guard", () => {
    expect(readFileSync("supabase/migrations/20261111000000_amazon_intelligence.sql", "utf8")).not.toMatch(/amazon_approval_guard|approvals_amazon_guard/);
  });
});

describe("approval guard: NULL values are refused, not waved through", () => {
  // Neither column can be NULL today (both are NOT NULL), so a scratch relaxation is needed to create the situation a three-valued <> would miss.
  // The constraint is restored and the rows removed afterwards.
  it("an insight whose environment is NULL is refused", async () => {
    const id = "cccccccc-0000-0000-0000-0000000000f1";
    await db.exec("alter table public.amazon_insights alter column environment drop not null");
    try {
      await db.exec(`insert into public.amazon_insights (id, org_id, environment, marketplace_id, kind, severity, title, summary, recommendation, evidence, dedupe_key)
        values ('${id}', '${ORG_A}', null, 'A21TJRUUN4KGV', 'low_inventory', 'act', 't', 's', 'r', '[{"metric":"x"}]', 'null-env')`);
      expect((await rows(`select environment from public.amazon_insights where id = '${id}'`))[0].environment).toBeNull(); // the fixture is real
      expect(await as(U.ownerA, () => fails(approval(ORG_A, ref(id))))).toMatch(/sandbox Amazon insights cannot be queued/);
      expect((await rows(`select count(*)::int as n from public.approvals where meta ->> 'ref' = '${id}'`))[0].n).toBe(0);
    } finally {
      await db.exec(`delete from public.amazon_insights where id = '${id}'`);
      await db.exec("alter table public.amazon_insights alter column environment set not null");
    }
  });
  it("an approval whose generated_by is NULL and claims to be an Amazon insight is refused", async () => {
    await db.exec("alter table public.approvals alter column generated_by drop not null");
    try {
      expect(await fails(`insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('${ORG_A}', 'nullgen', 'Amazon insight', null, 'p', ${lit(ref(INS.prodA))})`)).toMatch(/must be generated_by amazon/);
      expect((await rows("select count(*)::int as n from public.approvals where title = 'nullgen'"))[0].n).toBe(0);
    } finally {
      await db.exec("delete from public.approvals where generated_by is null");
      await db.exec("alter table public.approvals alter column generated_by set not null");
    }
  });
  it("the scratch relaxations were restored: both columns are NOT NULL again", async () => {
    const r = await rows(`select table_name, is_nullable from information_schema.columns where (table_name = 'amazon_insights' and column_name = 'environment') or (table_name = 'approvals' and column_name = 'generated_by') order by 1`);
    expect(r.map((x) => `${x.table_name}:${x.is_nullable}`)).toEqual(["amazon_insights:NO", "approvals:NO"]);
  });
});

describe("approval guard: the tests are not vacuous", () => {
  it("with the trigger disabled the same refused inserts succeed, so it is the guard that refuses them", async () => {
    await db.exec("alter table public.approvals disable trigger approvals_amazon_guard");
    try {
      await as(U.ownerA, () => db.query(approval(ORG_A, ref(INS.sandboxA), "amazon", "mutation-sandbox")));
      await as(U.ownerA, () => db.query(approval(ORG_A, ref(INS.prodB), "amazon", "mutation-cross")));
      await as(U.ownerA, () => db.query(approval(ORG_A, ref(MISSING), "amazon", "mutation-missing")));
      expect((await rows("select count(*)::int as n from public.approvals where type like 'mutation-%'"))[0].n).toBe(3);
    } finally {
      await db.exec("alter table public.approvals enable trigger approvals_amazon_guard");
      await db.exec("delete from public.approvals where type like 'mutation-%'");
    }
    expect(await as(U.ownerA, () => fails(approval(ORG_A, ref(INS.sandboxA))))).toMatch(/sandbox Amazon insights cannot be queued/);
  });
});
