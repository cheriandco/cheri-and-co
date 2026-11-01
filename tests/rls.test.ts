/** Row Level Security and organisation isolation, run against a real (in-process) Postgres. The Supabase pieces the
 *  migration relies on (auth.users, auth.uid(), the three API roles) are stubbed; the policies themselves are the real
 *  migration file. This proves the SQL, not the hosted project: nothing here talks to Supabase. */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const U = {
  ownerA: "11111111-0000-0000-0000-000000000001",
  staffA: "11111111-0000-0000-0000-000000000002",
  viewerA: "11111111-0000-0000-0000-000000000003",
  approverA: "11111111-0000-0000-0000-000000000004",
  ownerB: "22222222-0000-0000-0000-000000000001",
  loner: "33333333-0000-0000-0000-000000000001",
};

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

let db: PGlite;

/** Run statements as a signed-in user (or anon when sub is null). Resets afterwards. */
async function as<T>(sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.sub', '${sub ?? ""}', false); set role ${sub ? "authenticated" : "anon"};`);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.sub', '', false);"); }
}
const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
const fails = async (sql: string) => { try { await db.query(sql); return null; } catch (e) { return (e as Error).message; } };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(stub);
  await db.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
  const users = Object.values(U).map((id) => `('${id}', '{}')`).join(",");
  await db.exec(`
    insert into auth.users (id, raw_user_meta_data) values ${users};
    insert into public.organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into public.memberships (org_id, user_id, role) values
      ('${ORG_A}', '${U.ownerA}', 'owner'), ('${ORG_A}', '${U.staffA}', 'staff'),
      ('${ORG_A}', '${U.viewerA}', 'viewer'), ('${ORG_A}', '${U.approverA}', 'approver'),
      ('${ORG_B}', '${U.ownerB}', 'owner');
    insert into public.customers (org_id, name) values ('${ORG_A}', 'A customer'), ('${ORG_B}', 'B customer');
    insert into public.approvals (id, org_id, title, type, generated_by, preview) values
      ('aaaaaaaa-1111-0000-0000-000000000001', '${ORG_A}', 'A approval', 'Content', 'content', 'text'),
      ('bbbbbbbb-1111-0000-0000-000000000001', '${ORG_B}', 'B approval', 'Content', 'content', 'text');
  `);
});
afterAll(async () => { await db.close(); });

describe("every table is protected", () => {
  it("has RLS enabled on all public tables", async () => {
    const off = await rows("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(off).toEqual([]);
  });
  it("gives signed-out visitors no access at all", async () => {
    for (const t of ["organizations", "profiles", "memberships", "customers", "products", "retailers", "leads", "orders", "tasks", "approvals", "content_items", "agent_activity", "audit_log"]) {
      const err = await as(null, () => fails(`select * from public.${t}`));
      expect(err, t).toMatch(/permission denied/);
    }
  });
});

describe("organisation isolation", () => {
  it("members see only their own organisation's rows", async () => {
    expect((await as(U.ownerA, () => rows("select name from public.customers"))).map((r) => r.name)).toEqual(["A customer"]);
    expect((await as(U.ownerB, () => rows("select name from public.customers"))).map((r) => r.name)).toEqual(["B customer"]);
    expect((await as(U.ownerA, () => rows("select id from public.organizations"))).length).toBe(1);
  });
  it("a user with no membership sees nothing", async () => {
    expect(await as(U.loner, () => rows("select * from public.customers"))).toEqual([]);
    expect(await as(U.loner, () => rows("select * from public.approvals"))).toEqual([]);
  });
  it("cannot insert into, or move a row to, another organisation", async () => {
    const ins = await as(U.ownerA, () => fails(`insert into public.customers (org_id, name) values ('${ORG_B}', 'planted')`));
    expect(ins).toMatch(/row-level security/);
    const mv = await as(U.ownerA, () => fails(`update public.customers set org_id = '${ORG_B}' where name = 'A customer'`));
    expect(mv).toMatch(/row-level security/);
  });
  it("cannot touch another organisation's rows (updates and deletes match nothing)", async () => {
    await as(U.ownerA, () => db.query(`update public.customers set name = 'hacked' where org_id = '${ORG_B}'`));
    await as(U.ownerA, () => db.query(`delete from public.customers where org_id = '${ORG_B}'`));
    expect((await rows(`select name from public.customers where org_id = '${ORG_B}'`)).map((r) => r.name)).toEqual(["B customer"]);
  });
  it("a composite foreign key stops a lead pointing at another tenant's retailer", async () => {
    await db.exec(`insert into public.retailers (id, org_id, business) values ('cccccccc-0000-0000-0000-000000000001', '${ORG_B}', 'B retailer')`);
    const err = await fails(`insert into public.leads (org_id, retailer_id) values ('${ORG_A}', 'cccccccc-0000-0000-0000-000000000001')`);
    expect(err).toMatch(/foreign key/);
  });
});

describe("roles", () => {
  it("viewers read but cannot write", async () => {
    expect((await as(U.viewerA, () => rows("select * from public.customers"))).length).toBe(1);
    expect(await as(U.viewerA, () => fails(`insert into public.customers (org_id, name) values ('${ORG_A}', 'x')`))).toMatch(/row-level security/);
  });
  it("staff can write, but not delete", async () => {
    await as(U.staffA, () => db.query(`insert into public.tasks (org_id, title) values ('${ORG_A}', 'Follow up')`));
    await as(U.staffA, () => db.query("delete from public.tasks"));
    expect((await rows("select 1 from public.tasks")).length).toBe(1);
    await as(U.ownerA, () => db.query("delete from public.tasks"));
    expect((await rows("select 1 from public.tasks")).length).toBe(0);
  });
  it("nobody can write memberships from the API, so nobody can grant themselves a role", async () => {
    for (const u of [U.ownerA, U.staffA, U.loner]) {
      expect(await as(u, () => fails(`insert into public.memberships (org_id, user_id, role) values ('${ORG_A}', '${u}', 'owner')`))).toMatch(/permission denied/);
      expect(await as(u, () => fails(`update public.memberships set role = 'owner' where user_id = '${u}'`))).toMatch(/permission denied/);
    }
  });
  it("profiles: you see yourself and people in your organisation, never strangers", async () => {
    const seen = (await as(U.staffA, () => rows("select id from public.profiles"))).map((r) => r.id);
    expect(seen).toContain(U.staffA);
    expect(seen).toContain(U.ownerA);
    expect(seen).not.toContain(U.ownerB);
    expect(seen).not.toContain(U.loner);
  });
});

describe("approvals and audit", () => {
  const A = "aaaaaaaa-1111-0000-0000-000000000001";
  const B = "bbbbbbbb-1111-0000-0000-000000000001";
  it("approvals cannot be updated or deleted directly", async () => {
    expect(await as(U.ownerA, () => fails(`update public.approvals set status = 'approved' where id = '${A}'`))).toMatch(/permission denied/);
    expect(await as(U.ownerA, () => fails(`delete from public.approvals where id = '${A}'`))).toMatch(/permission denied/);
  });
  it("new approvals must start as pending", async () => {
    expect(await as(U.staffA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, preview, status) values ('${ORG_A}', 't', 'Content', 'b2c', 'p', 'approved')`))).toMatch(/row-level security/);
  });
  it("staff and viewers cannot decide; approvers can, and it writes an audit row with the real actor", async () => {
    expect(await as(U.staffA, () => fails(`select public.decide_approval('${A}', 'approve')`))).toMatch(/not authorized/);
    expect(await as(U.viewerA, () => fails(`select public.decide_approval('${A}', 'approve')`))).toMatch(/not authorized/);
    const r = await as(U.approverA, () => rows(`select status from public.decide_approval('${A}', 'approve', 'ok')`));
    expect(r[0].status).toBe("approved");
    const audit = await rows("select actor_id, action from public.audit_log");
    expect(audit).toEqual([{ actor_id: U.approverA, action: "approve" }]);
  });
  it("cannot decide twice", async () => {
    expect(await as(U.ownerA, () => fails(`select public.decide_approval('${A}', 'reject')`))).toMatch(/already decided/);
  });
  it("another organisation's approval looks like it does not exist", async () => {
    expect(await as(U.ownerA, () => fails(`select public.decide_approval('${B}', 'approve')`))).toMatch(/not found/);
    expect(await as(U.loner, () => fails(`select public.decide_approval('${B}', 'approve')`))).toMatch(/not found/);
    expect(await as(null, () => fails(`select public.decide_approval('${B}', 'approve')`))).toMatch(/permission denied/);
  });
  it("audit history is append-only, even for the service role", async () => {
    expect(await as(U.ownerA, () => fails("delete from public.audit_log"))).toMatch(/permission denied/);
    expect(await fails("update public.audit_log set note = 'x'")).toMatch(/append-only/);
    expect(await fails("delete from public.audit_log")).toMatch(/append-only/);
  });
  it("agent activity can only be recorded as yourself", async () => {
    expect(await as(U.staffA, () => fails(`insert into public.agent_activity (org_id, action, actor_id) values ('${ORG_A}', 'x', '${U.ownerA}')`))).toMatch(/row-level security/);
    await as(U.staffA, () => db.query(`insert into public.agent_activity (org_id, action, actor_id) values ('${ORG_A}', 'x', '${U.staffA}')`));
    expect(await fails("delete from public.agent_activity")).toMatch(/append-only/);
  });
});

describe("new users", () => {
  it("get a profile automatically and no organisation", async () => {
    await db.exec("insert into auth.users (id, raw_user_meta_data) values ('44444444-0000-0000-0000-000000000001', '{\"full_name\": \"New Person\"}')");
    expect((await rows("select display_name from public.profiles where id = '44444444-0000-0000-0000-000000000001'"))[0].display_name).toBe("New Person");
    expect(await rows("select * from public.memberships where user_id = '44444444-0000-0000-0000-000000000001'")).toEqual([]);
  });
});

describe("products and content items (real SQL in PGlite, not the hosted project)", () => {
  const PA = "cccccccc-1111-0000-0000-000000000001";
  const PB = "cccccccc-1111-0000-0000-000000000002";
  const CA = "dddddddd-1111-0000-0000-000000000001";
  const APP_A = "eeeeeeee-1111-0000-0000-000000000001";
  const APP_B = "bbbbbbbb-1111-0000-0000-000000000001";
  beforeAll(async () => {
    await db.exec(`
      insert into public.products (id, org_id, sku, name, price, stock) values
        ('${PA}', '${ORG_A}', 'SKU-1', 'A product', 100, 5), ('${PB}', '${ORG_B}', 'SKU-1', 'B product', 200, 7);
      insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${APP_A}', '${ORG_A}', 'Post', 'Content', 'content', 'text');
      insert into public.content_items (id, org_id, platform, title) values ('${CA}', '${ORG_A}', 'Instagram', 'A post');
    `);
  });

  it("members read only their own organisation's products and content", async () => {
    expect((await as(U.staffA, () => rows("select name from public.products"))).map((r) => r.name)).toEqual(["A product"]);
    expect((await as(U.ownerB, () => rows("select name from public.products"))).map((r) => r.name)).toEqual(["B product"]);
    expect((await as(U.ownerB, () => rows("select title from public.content_items"))).length).toBe(0);
  });
  it("writers can create and edit; a viewer cannot", async () => {
    await as(U.staffA, () => db.query(`insert into public.products (org_id, sku, name) values ('${ORG_A}', 'SKU-2', 'Second')`));
    await as(U.staffA, () => db.query(`update public.products set name = 'Renamed' where id = '${PA}'`));
    expect((await rows(`select name from public.products where id = '${PA}'`))[0].name).toBe("Renamed");
    expect(await as(U.viewerA, () => fails(`insert into public.products (org_id, sku, name) values ('${ORG_A}', 'SKU-3', 'x')`))).toMatch(/row-level security/);
    await as(U.viewerA, () => db.query(`update public.products set name = 'Hacked' where id = '${PA}'`));
    expect((await rows(`select name from public.products where id = '${PA}'`))[0].name).toBe("Renamed");
    expect(await as(U.viewerA, () => fails(`insert into public.content_items (org_id, platform, title) values ('${ORG_A}', 'Instagram', 'x')`))).toMatch(/row-level security/);
  });
  it("cannot write into, or edit, another organisation's catalogue", async () => {
    expect(await as(U.ownerA, () => fails(`insert into public.products (org_id, sku, name) values ('${ORG_B}', 'SKU-9', 'x')`))).toMatch(/row-level security/);
    await as(U.ownerA, () => db.query(`update public.products set name = 'Hijacked' where id = '${PB}'`));
    expect((await rows(`select name from public.products where id = '${PB}'`))[0].name).toBe("B product");
    expect(await as(U.ownerA, () => fails(`update public.products set org_id = '${ORG_B}' where id = '${PA}'`))).toMatch(/row-level security/);
  });
  it("SKUs are unique inside an organisation but may repeat across organisations", async () => {
    expect(await as(U.staffA, () => fails(`insert into public.products (org_id, sku, name) values ('${ORG_A}', 'SKU-1', 'dup')`))).toMatch(/duplicate key/);
  });
  it("the table's own checks reject bad values", async () => {
    for (const bad of ["price = -1", "stock = -1", "status = 'sold'", "name = ''"]) {
      expect(await as(U.staffA, () => fails(`update public.products set ${bad} where id = '${PA}'`)), bad).toMatch(/check constraint/);
    }
    for (const bad of [`platform = 'TikTok'`, `status = 'live'`, `caption = '${"x".repeat(2201)}'`]) {
      expect(await as(U.staffA, () => fails(`update public.content_items set ${bad} where id = '${CA}'`)), bad).toMatch(/check constraint/);
    }
  });
  it("only owner or admin can delete products", async () => {
    await as(U.staffA, () => db.query(`delete from public.products where sku = 'SKU-2'`));
    expect((await rows("select 1 from public.products where sku = 'SKU-2'")).length).toBe(1);
    await as(U.ownerA, () => db.query(`delete from public.products where sku = 'SKU-2'`));
    expect((await rows("select 1 from public.products where sku = 'SKU-2'")).length).toBe(0);
  });
  it("a post can link only to an approval in its own organisation", async () => {
    expect(await as(U.staffA, () => fails(`update public.content_items set approval_id = '${APP_B}' where id = '${CA}'`))).toMatch(/foreign key/);
    await as(U.staffA, () => db.query(`update public.content_items set status = 'pending_approval', approval_id = '${APP_A}' where id = '${CA}'`));
    expect((await rows(`select status from public.content_items where id = '${CA}'`))[0].status).toBe("pending_approval");
  });
  it("approval workflow: a writer queues a pending approval; only approvers decide; the decision can be mirrored onto the post", async () => {
    expect(await as(U.staffA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, preview, status) values ('${ORG_A}', 'x', 'Content', 'content', 'p', 'approved')`))).toMatch(/row-level security/);
    expect(await as(U.staffA, () => fails(`select public.decide_approval('${APP_A}', 'approve')`))).toBeTruthy();
    await as(U.approverA, () => db.query(`select public.decide_approval('${APP_A}', 'approve')`));
    await as(U.approverA, () => db.query(`update public.content_items set status = 'approved' where approval_id = '${APP_A}'`));
    expect((await rows(`select status from public.content_items where id = '${CA}'`))[0].status).toBe("approved");
    expect((await rows(`select status from public.approvals where id = '${APP_A}'`))[0].status).toBe("approved");
  });
});
