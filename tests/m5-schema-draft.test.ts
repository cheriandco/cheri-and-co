/** M5.1: the Amazon schema, loaded on top of the real foundation migration in an in-process Postgres.
 *  The SQL comes from the LOCAL migration file `supabase/migrations/20261111000000_amazon_intelligence.sql`, and a test proves it is identical to the SQL
 *  block in docs/M5_SCHEMA_PROPOSAL.md, so the document and the migration cannot drift apart. The migration has NOT been applied anywhere and nothing here
 *  talks to Supabase: this proves the SQL and its policies, not the hosted service. */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const U = {
  ownerA: "11111111-0000-0000-0000-000000000001", adminA: "11111111-0000-0000-0000-000000000005", approverA: "11111111-0000-0000-0000-000000000004",
  staffA: "11111111-0000-0000-0000-000000000002", viewerA: "11111111-0000-0000-0000-000000000003", ownerB: "22222222-0000-0000-0000-000000000001",
  loner: "33333333-0000-0000-0000-000000000001",
};
const TABLES = ["amazon_connections", "amazon_sync_runs", "amazon_orders", "amazon_order_items", "amazon_products", "amazon_inventory", "amazon_reports", "amazon_insights"];

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

const MIGRATION = "supabase/migrations/20261111000000_amazon_intelligence.sql";
const stripHeader = (sql: string) => sql.replace(/\r\n/g, "\n").replace(/^(--[^\n]*\n)+\n/, "").trimEnd();

function draftSql(): string {
  const doc = readFileSync("docs/M5_SCHEMA_PROPOSAL.md", "utf8").replace(/\r\n/g, "\n");
  const m = doc.match(/## 3\. Draft SQL\n\n```sql\n([\s\S]*?)\n```/);
  if (!m) throw new Error("Draft SQL block not found in docs/M5_SCHEMA_PROPOSAL.md");
  return m[1];
}

let db: PGlite;
async function as<T>(sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.sub', '${sub ?? ""}', false); set role ${sub ? "authenticated" : "anon"};`);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.sub', '', false);"); }
}
const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
const fails = async (sql: string) => { try { await db.query(sql); return null; } catch (e) { return (e as Error).message; } };

const order = (org: string, env: string, id: string) =>
  `insert into public.amazon_orders (org_id, environment, marketplace_id, amazon_order_id, created_time, last_updated_time, fulfillment_status) values ('${org}', '${env}', 'A21TJRUUN4KGV', '${id}', now(), now(), 'SHIPPED')`;
const run = (org: string, kind: string, status: string) =>
  `insert into public.amazon_sync_runs (org_id, environment, marketplace_id, kind, status) values ('${org}', 'sandbox', 'A21TJRUUN4KGV', '${kind}', '${status}')`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(stub);
  await db.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
  await db.exec(readFileSync(MIGRATION, "utf8"));
  await db.exec(`
    insert into auth.users (id, raw_user_meta_data) values ${Object.values(U).map((id) => `('${id}', '{}')`).join(",")};
    insert into public.organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into public.memberships (org_id, user_id, role) values
      ('${ORG_A}', '${U.ownerA}', 'owner'), ('${ORG_A}', '${U.adminA}', 'admin'), ('${ORG_A}', '${U.approverA}', 'approver'),
      ('${ORG_A}', '${U.staffA}', 'staff'), ('${ORG_A}', '${U.viewerA}', 'viewer'), ('${ORG_B}', '${U.ownerB}', 'owner');
  `);
});
afterAll(async () => { await db.close(); });

describe("draft Amazon schema: structure", () => {
  it("applies cleanly on top of the foundation and creates exactly the eight proposed tables", async () => {
    const found = (await rows("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and relname like 'amazon\\_%' order by 1")).map((r) => r.relname);
    expect(found).toEqual([...TABLES].sort());
  });
  it("has RLS enabled on every table (and on every public table)", async () => {
    expect(await rows("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")).toEqual([]);
  });
  it("every table carries org_id and environment", async () => {
    for (const t of TABLES) {
      const cols = (await rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = '${t}'`)).map((r) => r.column_name);
      expect(cols, t).toContain("org_id");
      expect(cols, t).toContain("environment");
    }
  });
  it("no table has a column that could hold buyer or recipient data or a credential", async () => {
    const cols = (await rows(`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'amazon\\_%'`)).map((r) => `${r.table_name}.${r.column_name}`);
    const bad = cols.filter((c) => /buyer|recipient|address|phone|email|customer|name_?on|token|secret|password|refresh/i.test(c.split(".")[1]) && !/store_name|marketplace_name|product_name|brand/.test(c));
    expect(bad).toEqual([]);
  });
  it("anon holds no privileges on the new tables", async () => {
    for (const t of TABLES) expect(await as(null, () => fails(`select * from public.${t}`)), t).toMatch(/permission denied/);
  });
});

describe("draft Amazon schema: isolation and roles", () => {
  it("synchronised data: owner and admin write, approver/staff/viewer cannot, everyone in the organisation reads", async () => {
    await as(U.adminA, () => db.query(order(ORG_A, "sandbox", "AO-1")));
    await as(U.ownerA, () => db.query(order(ORG_A, "sandbox", "AO-2")));
    for (const u of [U.approverA, U.staffA, U.viewerA]) expect(await as(u, () => fails(order(ORG_A, "sandbox", `AO-x-${u.slice(-2)}`))), u).toMatch(/row-level security/);
    for (const u of [U.ownerA, U.approverA, U.staffA, U.viewerA]) expect((await as(u, () => rows("select amazon_order_id from public.amazon_orders"))).length, u).toBe(2);
  });
  it("another organisation sees nothing and cannot write into this one", async () => {
    expect(await as(U.ownerB, () => rows("select * from public.amazon_orders"))).toEqual([]);
    expect(await as(U.loner, () => rows("select * from public.amazon_orders"))).toEqual([]);
    expect(await as(U.ownerB, () => fails(order(ORG_A, "sandbox", "AO-planted")))).toMatch(/row-level security/);
  });
  it("cannot move a row to another organisation, and another organisation's update or delete matches nothing", async () => {
    expect(await as(U.ownerA, () => fails(`update public.amazon_orders set org_id = '${ORG_B}' where amazon_order_id = 'AO-1'`))).toMatch(/cannot be changed|row-level security/);
    await as(U.ownerB, () => db.query("update public.amazon_orders set fulfillment_status = 'HACKED'"));
    await as(U.ownerB, () => db.query("delete from public.amazon_orders"));
    expect((await rows("select fulfillment_status from public.amazon_orders where amazon_order_id = 'AO-1'"))[0].fulfillment_status).toBe("SHIPPED");
  });
  it("sandbox and production rows with the same Amazon order id coexist; a duplicate inside one environment is refused", async () => {
    await as(U.ownerA, () => db.query(order(ORG_A, "production", "AO-1")));
    expect((await rows(`select environment from public.amazon_orders where amazon_order_id = 'AO-1' order by 1`)).map((r) => r.environment)).toEqual(["production", "sandbox"]);
    expect(await as(U.ownerA, () => fails(order(ORG_A, "sandbox", "AO-1")))).toMatch(/duplicate key/);
  });
  it("an unknown environment is refused", async () => {
    expect(await as(U.ownerA, () => fails(order(ORG_A, "test", "AO-env")))).toMatch(/check constraint/);
  });
  it("an order item cannot point at another environment's order, but can at its own", async () => {
    const item = (env: string, id: string) => `insert into public.amazon_order_items (org_id, environment, marketplace_id, amazon_order_id, order_item_id, ordered_at, quantity) values ('${ORG_A}', '${env}', 'A21TJRUUN4KGV', '${id}', 'I-1', now(), 1)`;
    await as(U.ownerA, () => db.query(order(ORG_A, "sandbox", "AO-3")));
    await as(U.ownerA, () => db.query(item("sandbox", "AO-3")));
    expect(await as(U.ownerA, () => fails(item("production", "AO-3")))).toMatch(/foreign key/);
  });
  it("deleting a sync run keeps its orders and clears only the link", async () => {
    await as(U.ownerA, () => db.query(run(ORG_A, "reports", "succeeded")));
    const id = (await rows("select id from public.amazon_sync_runs where kind = 'reports'"))[0].id;
    await as(U.ownerA, () => db.query(`update public.amazon_orders set sync_run_id = '${id}' where amazon_order_id = 'AO-2'`));
    await db.exec(`delete from public.amazon_sync_runs where id = '${id}'`);
    expect((await rows("select sync_run_id from public.amazon_orders where amazon_order_id = 'AO-2'"))[0].sync_run_id).toBeNull();
  });
});

describe("draft Amazon schema: sync runs", () => {
  it("only one active run per kind; a finished run does not block the next", async () => {
    await as(U.ownerA, () => db.query(run(ORG_A, "orders", "running")));
    expect(await as(U.ownerA, () => fails(run(ORG_A, "orders", "queued")))).toMatch(/duplicate key/);
    await as(U.ownerA, () => db.query(run(ORG_A, "inventory", "running"))); // a different kind is fine
    await as(U.ownerA, () => db.query("update public.amazon_sync_runs set status = 'succeeded' where kind = 'orders'"));
    await as(U.ownerA, () => db.query(run(ORG_A, "orders", "queued")));
  });
  it("viewer and staff cannot start or change a run; run history cannot be deleted through the API", async () => {
    for (const u of [U.viewerA, U.staffA, U.approverA]) expect(await as(u, () => fails(run(ORG_A, "catalog", "queued"))), u).toMatch(/row-level security/);
    expect(await as(U.ownerA, () => fails("delete from public.amazon_sync_runs"))).toMatch(/permission denied/);
  });
});

describe("draft Amazon schema: insights and approvals", () => {
  const insight = (org: string, key: string, approval = "null") =>
    `insert into public.amazon_insights (org_id, environment, marketplace_id, kind, severity, title, summary, recommendation, evidence, dedupe_key, approval_id) values ('${org}', 'production', 'A21TJRUUN4KGV', 'low_inventory', 'act', 't', 's', 'r', '[{"metric":"fulfillable","value":2}]', '${key}', ${approval})`;
  it("only owner and admin create insights; approver, staff and viewer cannot plant one", async () => {
    for (const [u, k] of [[U.ownerA, "k1"], [U.adminA, "k2"]] as const) await as(u, () => db.query(insight(ORG_A, k)));
    for (const u of [U.approverA, U.staffA, U.viewerA]) expect(await as(u, () => fails(insight(ORG_A, `k-${u.slice(-2)}`))), u).toMatch(/row-level security/);
    await db.exec(insight(ORG_A, "k4")); // seeded by a statement with no signed-in user (the SQL editor)
  });
  it("approver and staff may set status and approval_id on an insight but change nothing else", async () => {
    for (const u of [U.approverA, U.staffA]) {
      await as(u, () => db.query("update public.amazon_insights set status = 'submitted' where dedupe_key = 'k1'"));
      for (const col of ["title = 'tampered'", "evidence = '[{\"metric\":\"fake\"}]'", "severity = 'info'", "summary = 'x'", "recommendation = 'x'", "dedupe_key = 'k-moved'"])
        expect(await as(u, () => fails(`update public.amazon_insights set ${col} where dedupe_key = 'k1'`)), `${u} ${col}`).toMatch(/only status and approval_id/);
    }
    expect((await rows("select status, title from public.amazon_insights where dedupe_key = 'k1'"))[0]).toMatchObject({ status: "submitted", title: "t" });
    await as(U.viewerA, () => db.query("update public.amazon_insights set status = 'dismissed'"));
    expect((await rows("select status from public.amazon_insights where dedupe_key = 'k1'"))[0].status).toBe("submitted"); // viewer's update matched nothing
  });
  it("an owner or admin may correct an insight, and a statement with no signed-in user is not restricted", async () => {
    await as(U.adminA, () => db.query("update public.amazon_insights set title = 'edited by admin' where dedupe_key = 'k2'"));
    await db.exec("update public.amazon_insights set title = 't' where dedupe_key = 'k2'");
  });
  it("evidence is mandatory: an empty or non-array value is refused", async () => {
    const bad = (e: string) => `insert into public.amazon_insights (org_id, environment, marketplace_id, kind, severity, title, summary, recommendation, evidence, dedupe_key) values ('${ORG_A}', 'production', 'M', 'low_inventory', 'act', 't', 's', 'r', '${e}', 'bad-${e.length}')`;
    expect(await as(U.ownerA, () => fails(bad("[]")))).toMatch(/check constraint/);
    expect(await as(U.ownerA, () => fails(bad('{"a":1}')))).toMatch(/check constraint/);
  });
  it("an insight can link only to an approval in its own organisation", async () => {
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('eeeeeeee-0000-0000-0000-00000000000a', '${ORG_A}', 'x', 'Amazon insight', 'amazon', 'p'), ('eeeeeeee-0000-0000-0000-00000000000b', '${ORG_B}', 'x', 'Amazon insight', 'amazon', 'p')`);
    expect(await as(U.ownerA, () => fails(insight(ORG_A, "link-bad", "'eeeeeeee-0000-0000-0000-00000000000b'")))).toMatch(/foreign key/);
    await as(U.ownerA, () => db.query(insight(ORG_A, "link-ok", "'eeeeeeee-0000-0000-0000-00000000000a'")));
  });
  it("only owner or admin can delete an insight", async () => {
    await as(U.staffA, () => db.query("delete from public.amazon_insights where dedupe_key = 'k4'"));
    expect((await rows("select 1 from public.amazon_insights where dedupe_key = 'k4'")).length).toBe(1);
    await as(U.adminA, () => db.query("delete from public.amazon_insights where dedupe_key = 'k4'"));
    expect((await rows("select 1 from public.amazon_insights where dedupe_key = 'k4'")).length).toBe(0);
  });
  it("the foundation approval rules are unchanged: staff cannot decide, an approver can, and the audit row names them", async () => {
    const id = "eeeeeeee-0000-0000-0000-00000000000a";
    expect(await as(U.staffA, () => fails(`select public.decide_approval('${id}', 'approve')`))).toMatch(/not authorized/);
    await as(U.approverA, () => db.query(`select public.decide_approval('${id}', 'approve')`));
    expect((await rows(`select actor_id from public.audit_log where approval_id = '${id}'`))[0].actor_id).toBe(U.approverA);
  });
});

describe("draft Amazon schema: the other tables take the same writes", () => {
  it("products, inventory, reports, connections accept a valid row from an admin and refuse a negative quantity", async () => {
    await as(U.adminA, () => db.query(`insert into public.amazon_products (org_id, environment, marketplace_id, seller_sku) values ('${ORG_A}', 'sandbox', 'M', 'SKU-1')`));
    await as(U.adminA, () => db.query(`insert into public.amazon_inventory (org_id, environment, marketplace_id, seller_sku, source, fulfillable) values ('${ORG_A}', 'sandbox', 'M', 'SKU-1', 'fba', 4)`));
    await as(U.adminA, () => db.query(`insert into public.amazon_reports (org_id, environment, marketplace_id, report_type, amazon_report_id, processing_status) values ('${ORG_A}', 'sandbox', 'M', 'GET_MERCHANT_LISTINGS_DATA', 'R1', 'DONE')`));
    await as(U.adminA, () => db.query(`insert into public.amazon_connections (org_id, environment, marketplace_id) values ('${ORG_A}', 'sandbox', 'A21TJRUUN4KGV')`));
    expect(await as(U.adminA, () => fails(`insert into public.amazon_inventory (org_id, environment, marketplace_id, seller_sku, source, fulfillable) values ('${ORG_A}', 'sandbox', 'M', 'SKU-2', 'fba', -1)`))).toMatch(/check constraint/);
    expect(await as(U.adminA, () => fails(`insert into public.amazon_inventory (org_id, environment, marketplace_id, seller_sku, source) values ('${ORG_A}', 'sandbox', 'M', 'SKU-3', 'guess')`))).toMatch(/check constraint/);
    expect(await as(U.staffA, () => fails(`insert into public.amazon_products (org_id, environment, marketplace_id, seller_sku) values ('${ORG_A}', 'sandbox', 'M', 'SKU-9')`))).toMatch(/row-level security/);
  });
  it("the existing orders table is untouched: no Amazon column was added", async () => {
    const cols = (await rows("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'orders'")).map((r) => r.column_name);
    expect(cols.sort()).toEqual(["channel", "created_at", "customer_id", "id", "line_items", "ordered_at", "org_id", "retailer_id", "status", "total"]);
  });
});

describe("migration file and scope guards", () => {
  it("the migration file is exactly the SQL in the proposal document", () => {
    expect(stripHeader(readFileSync(MIGRATION, "utf8"))).toBe(draftSql().trimEnd());
  });
  it("is forward-only: creates only new objects and never touches an existing table", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).not.toMatch(/(drop|truncate)/i);
    expect(sql).not.toMatch(/alter table public\.(?!amazon_)/i);
    expect(sql).not.toMatch(/(insert into|update|delete from)\s+public\.(?!amazon_)/i);
  });
  it("an admin cannot relabel a row as another environment, marketplace or organisation, on any table", async () => {
    const targets: [string, string][] = [
      ["amazon_connections", "marketplace_id = 'A21TJRUUN4KGV'"], ["amazon_orders", "amazon_order_id = 'AO-1' and environment = 'sandbox'"], ["amazon_products", "seller_sku = 'SKU-1'"],
      ["amazon_inventory", "seller_sku = 'SKU-1'"], ["amazon_reports", "amazon_report_id = 'R1'"], ["amazon_sync_runs", "kind = 'inventory'"], ["amazon_insights", "dedupe_key = 'k1'"],
    ];
    for (const [t, where] of targets) {
      for (const set of ["environment = case when environment = 'sandbox' then 'production' else 'sandbox' end", "marketplace_id = 'OTHER'", `org_id = '${ORG_B}'`]) {
        const n = (await rows(`select count(*)::int as n from public.${t} where ${where}`))[0].n as number;
        expect(n, `${t} fixture row for: ${where}`).toBeGreaterThan(0); // an update that matches nothing proves nothing
        const msg = await as(U.ownerA, () => fails(`update public.${t} set ${set} where ${where}`));
        expect(msg, `${t} ${set}`).toMatch(/cannot be changed|row-level security/);
      }
    }
    const item = (await rows("select count(*)::int as n from public.amazon_order_items"))[0].n;
    expect(item).toBeGreaterThan(0);
    expect(await as(U.ownerA, () => fails("update public.amazon_order_items set environment = 'production'"))).toMatch(/cannot be changed|foreign key/);
  });
  it("an unchanged scope still updates normally (an upsert rewrites the same key)", async () => {
    await as(U.adminA, () => db.query("update public.amazon_orders set fulfillment_status = 'DELIVERED', org_id = org_id, environment = environment where amazon_order_id = 'AO-1' and environment = 'sandbox'"));
    expect((await rows("select fulfillment_status from public.amazon_orders where amazon_order_id = 'AO-1' and environment = 'sandbox'"))[0].fulfillment_status).toBe("DELIVERED");
  });
  it("the time index for sales reads exists", async () => {
    expect((await rows("select 1 from pg_indexes where indexname = 'amazon_order_items_by_time'")).length).toBe(1);
  });
});
