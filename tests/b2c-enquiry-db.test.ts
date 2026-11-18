/** B2C enquiries: the workflow rules enforced BY THE DATABASE (audit finding H1, M2, M3, M4 and the migration extras), run against the real migration SQL in an
 *  in-process Postgres (PGlite). Supabase's own pieces (auth.users, auth.uid(), the API roles) are stubbed; nothing here talks to a hosted project.
 *
 *  The same attack scripts also run against tests/fixtures/b2c_enquiries_audit_baseline.sql, the migration as it was when the audit found the bypasses. There the
 *  attacks SUCCEED, which proves these tests fail on the old implementation and pass on the new one.
 *
 *  Concurrency: PGlite is one connection and serialises every query, so the "simultaneous" cases below are deterministic interleavings and idempotency checks,
 *  NOT proof of lock behaviour under real concurrent connections. What they do prove: the unique indexes and the row-state checks that make a race safe are present
 *  and refuse the second writer. The lock calls themselves (select ... for update, advisory lock) are exercised only for syntax and single-connection behaviour. */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const OWNER = "11111111-0000-0000-0000-000000000001";
const STAFF = "11111111-0000-0000-0000-000000000002";
const VIEWER = "11111111-0000-0000-0000-000000000003";
const APPROVER = "11111111-0000-0000-0000-000000000004";
const OWNER_B = "22222222-0000-0000-0000-000000000001";
const APP_B = "bbbbbbbb-1111-0000-0000-000000000001"; // another organisation's reply approval
const APP_OTHER_TYPE = "aaaaaaaa-1111-0000-0000-000000000009"; // this organisation, already approved, but NOT a reply approval

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

const MIGRATION = readFileSync("supabase/migrations/20261114000000_b2c_enquiries.sql", "utf8");
const BASELINE = readFileSync("tests/fixtures/b2c_enquiries_audit_baseline.sql", "utf8");

interface World { db: PGlite; as: <T>(sub: string, fn: () => Promise<T>) => Promise<T>; rows: (sql: string) => Promise<Record<string, any>[]>; err: (sub: string, sql: string) => Promise<string | null>; n: number } // eslint-disable-line @typescript-eslint/no-explicit-any -- rows of arbitrary SQL

async function boot(b2c: string): Promise<World> {
  const db = new PGlite();
  await db.exec(stub);
  await db.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20261113000000_product_description_image.sql", "utf8"));
  await db.exec(b2c);
  await db.exec(`
    insert into auth.users (id, raw_user_meta_data) values ('${OWNER}','{}'),('${STAFF}','{}'),('${VIEWER}','{}'),('${APPROVER}','{}'),('${OWNER_B}','{}');
    insert into public.organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into public.memberships (org_id, user_id, role) values ('${ORG_A}','${OWNER}','owner'),('${ORG_A}','${STAFF}','staff'),('${ORG_A}','${VIEWER}','viewer'),('${ORG_A}','${APPROVER}','approver'),('${ORG_B}','${OWNER_B}','owner');
    insert into public.approvals (id, org_id, title, type, generated_by, status, preview, meta) values
      ('${APP_B}', '${ORG_B}', 'B reply', 'B2C Reply', 'b2c', 'approved', 'other org text', '{"kind":"b2c_reply"}'),
      ('${APP_OTHER_TYPE}', '${ORG_A}', 'A content', 'Content', 'content', 'approved', 'content text', '{"kind":"content_draft"}');
  `);
  const w: World = {
    db, n: 0,
    as: async (sub, fn) => { await db.exec(`select set_config('request.jwt.sub', '${sub}', false); set role authenticated;`); try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.sub', '', false);"); } },
    rows: async (sql) => (await db.query<Record<string, unknown>>(sql)).rows,
    err: async (sub, sql) => w.as(sub, async () => { try { await db.query(sql); return null; } catch (e) { return (e as Error).message; } }),
  };
  return w;
}

const uid = (w: World, k: number) => `${String(k).padStart(8, "0")}-0000-4000-8000-${String(++w.n).padStart(12, "0")}`;

/** A fresh enquiry in org A with one inbound message and one outbound draft (made as the table owner, so no rule is under test here). */
async function draft(w: World, body = "Thank you for your message. We would be happy to help.\n\nCheri & Co."): Promise<{ e: string; m: string }> {
  const e = uid(w, 1), m = uid(w, 2);
  await w.db.exec(`insert into public.enquiries (id, org_id, subject) values ('${e}', '${ORG_A}', 'subject');
    insert into public.enquiry_messages (org_id, enquiry_id, direction, body) values ('${ORG_A}', '${e}', 'inbound', 'Do you have hoops?');
    insert into public.enquiry_messages (id, org_id, enquiry_id, direction, body, status, generated_by) values ('${m}', '${ORG_A}', '${e}', 'outbound', '${body.replace(/'/g, "''")}', 'draft', 'template');`);
  return { e, m };
}

/** What the application's submit step used to do, with plain statements (works on both versions): a pending reply approval carrying the message text, linked to it. */
async function submitByHand(w: World, m: string): Promise<string> {
  const a = uid(w, 3);
  await w.as(STAFF, async () => {
    await w.db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, status, preview, meta)
      select '${a}', org_id, 'Reply', 'B2C Reply', 'b2c', 'pending', body, '{"kind":"b2c_reply"}' from public.enquiry_messages where id = '${m}';
      update public.enquiry_messages set status = 'pending_approval', approval_id = '${a}' where id = '${m}';`);
  });
  return a;
}
const decide = (w: World, a: string, action: "approve" | "reject" | "edit", preview = "null") => w.as(APPROVER, () => w.db.query(`select public.decide_approval('${a}', '${action}', 'note', null, ${preview})`));

/** A message that went through the legitimate flow to 'approved' (on the old schema the app's own best-effort sync set the status; on the new one a trigger does). */
async function approvedMessage(w: World, legacy: boolean): Promise<{ e: string; m: string; a: string }> {
  const { e, m } = await draft(w);
  const a = await submitByHand(w, m);
  await decide(w, a, "approve");
  if (legacy) await w.as(STAFF, () => w.db.query(`update public.enquiry_messages set status = 'approved' where id = '${m}'`));
  return { e, m, a };
}

type Attack = (w: World, legacy: boolean) => Promise<boolean>; // true = the attack went through
const ok = async (w: World, sub: string, sql: string) => (await w.err(sub, sql)) === null;

const ATTACKS: Record<string, Attack> = {
  "staff marks a draft approved with no approval at all": async (w) => { const { m } = await draft(w); return ok(w, STAFF, `update public.enquiry_messages set status = 'approved' where id = '${m}'`); },
  "staff marks a draft as sent_manually without an approval": async (w) => { const { m } = await draft(w); return ok(w, STAFF, `update public.enquiry_messages set status = 'sent_manually' where id = '${m}'`); },
  "staff rewrites the text after approval": async (w, l) => { const { m } = await approvedMessage(w, l); return ok(w, STAFF, `update public.enquiry_messages set body = 'changed after approval' where id = '${m}'`); },
  "staff rewrites the text while it waits for a decision": async (w) => { const { m } = await draft(w); await submitByHand(w, m); return ok(w, STAFF, `update public.enquiry_messages set body = 'changed while pending' where id = '${m}'`); },
  "staff rewrites a customer's inbound message": async (w) => { const { e } = await draft(w); return ok(w, STAFF, `update public.enquiry_messages set body = 'tampered' where enquiry_id = '${e}' and direction = 'inbound'`); },
  "staff links another organisation's approved reply approval": async (w) => { const { m } = await draft(w); return ok(w, STAFF, `update public.enquiry_messages set status = 'approved', approval_id = '${APP_B}' where id = '${m}'`); },
  "staff links this organisation's approved approval of the wrong type": async (w) => { const { m } = await draft(w); return ok(w, STAFF, `update public.enquiry_messages set status = 'approved', approval_id = '${APP_OTHER_TYPE}' where id = '${m}'`); },
  "staff detaches the approval after it was approved": async (w, l) => { const { m } = await approvedMessage(w, l); return ok(w, STAFF, `update public.enquiry_messages set approval_id = null where id = '${m}'`); },
  "staff swaps the approval for a different approved one": async (w, l) => { const { m } = await approvedMessage(w, l); return ok(w, STAFF, `update public.enquiry_messages set approval_id = '${APP_OTHER_TYPE}' where id = '${m}'`); },
  "staff sets the enquiry status directly": async (w) => { const { e } = await draft(w); return ok(w, STAFF, `update public.enquiries set status = 'replied' where id = '${e}'`); },
  "staff adds a second live draft to the same enquiry": async (w) => { const { e } = await draft(w); return ok(w, STAFF, `insert into public.enquiry_messages (org_id, enquiry_id, direction, body, status) values ('${ORG_A}', '${e}', 'outbound', 'second draft', 'draft')`); },
  "staff inserts a reply that is already approved": async (w) => { const e = uid(w, 1); await w.db.exec(`insert into public.enquiries (id, org_id, subject) values ('${e}', '${ORG_A}', 's')`); return ok(w, STAFF, `insert into public.enquiry_messages (org_id, enquiry_id, direction, body, status) values ('${ORG_A}', '${e}', 'outbound', 'born approved', 'approved')`); },
  "staff spoofs created_by on a new enquiry": async (w) => {
    const r = await w.as(STAFF, async () => { try { return (await w.db.query<{ created_by: string }>(`insert into public.enquiries (org_id, subject, created_by) values ('${ORG_A}', 'spoof', '${APPROVER}') returning created_by`)).rows[0].created_by; } catch { return null; } });
    return r === APPROVER;
  },
  "staff re-attributes an existing message to another user": async (w) => { const { m } = await draft(w); return ok(w, STAFF, `update public.enquiry_messages set created_by = '${APPROVER}' where id = '${m}'`); },
};

describe("H1: the old migration let a writer bypass the workflow; the new one does not", () => {
  let oldDb: World, newDb: World;
  beforeAll(async () => { oldDb = await boot(BASELINE); newDb = await boot(MIGRATION); });
  afterAll(async () => { await oldDb.db.close(); await newDb.db.close(); });

  // Attacks that the old schema already stopped (a composite foreign key) stay refused on both; every other attack is a real regression test.
  const ALREADY_BLOCKED = new Set(["staff links another organisation's approved reply approval"]);

  for (const [name, attack] of Object.entries(ATTACKS)) {
    it(`${name}: refused by the new migration`, async () => { expect(await attack(newDb, false)).toBe(false); });
    it(`${name}: ${ALREADY_BLOCKED.has(name) ? "was already refused by the old schema (foreign key)" : "WENT THROUGH on the old schema (so this test fails there)"}`, async () => {
      expect(await attack(oldDb, true)).toBe(!ALREADY_BLOCKED.has(name));
    });
  }

  it("the legitimate flow still works end to end: submit -> approver decides -> trigger copies the decision -> a person records the manual send", async () => {
    const { e, m } = await draft(newDb);
    const before = (await newDb.rows(`select body from public.enquiry_messages where id = '${m}'`))[0].body;
    const sub = await newDb.as(STAFF, () => newDb.db.query<{ id: string; status: string; preview: string }>(`select * from public.submit_b2c_reply('${ORG_A}', '${e}', '${m}', ${lit(before)}, 'Reply · hoops', 'hoops')`));
    const approval = sub.rows[0];
    expect(approval).toMatchObject({ status: "pending", preview: before });
    expect((await newDb.rows(`select status, approval_id from public.enquiry_messages where id = '${m}'`))[0]).toMatchObject({ status: "pending_approval", approval_id: approval.id });
    expect((await newDb.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("awaiting_approval");
    // staff cannot decide; the approver can, and the message follows in the same transaction
    expect(await newDb.err(STAFF, `select public.decide_approval('${approval.id}', 'approve', 'x', null, null)`)).toBeTruthy();
    await decide(newDb, approval.id, "approve");
    expect((await newDb.rows(`select status from public.enquiry_messages where id = '${m}'`))[0].status).toBe("approved");
    expect((await newDb.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("approved");
    expect(await newDb.err(STAFF, `update public.enquiry_messages set status = 'sent_manually' where id = '${m}'`)).toBeNull();
    expect((await newDb.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("replied");
    // history is frozen
    expect(await newDb.err(STAFF, `update public.enquiry_messages set body = 'after the fact' where id = '${m}'`)).toMatch(/cannot be changed/);
  });

  it("rejection is copied the same way, and the rejected reply can return to a draft (new text, no approval link) and be submitted again", async () => {
    const { e, m } = await draft(newDb);
    const a = await submitByHand(newDb, m);
    await decide(newDb, a, "reject");
    expect((await newDb.rows(`select status from public.enquiry_messages where id = '${m}'`))[0].status).toBe("rejected");
    expect((await newDb.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("draft_ready");
    expect(await newDb.err(STAFF, `update public.enquiry_messages set status = 'approved' where id = '${m}'`)).toBeTruthy(); // a rejected reply cannot be pushed to approved
    expect(await newDb.err(STAFF, `update public.enquiry_messages set body = 'A friendlier version.', status = 'draft', approval_id = null where id = '${m}'`)).toBeNull();
    const again = await submitByHand(newDb, m);
    expect(again).not.toBe(a);
    expect((await newDb.rows(`select status from public.enquiry_messages where id = '${m}'`))[0].status).toBe("pending_approval");
  });

  it("a staff-crafted approval whose text differs from the message, or that is not pending, cannot be linked", async () => {
    const { m } = await draft(newDb);
    const wrongText = uid(newDb, 3), notPending = uid(newDb, 3);
    await newDb.db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, status, preview, meta) values
      ('${wrongText}', '${ORG_A}', 'x', 'B2C Reply', 'b2c', 'pending', 'different words', '{"kind":"b2c_reply"}'),
      ('${notPending}', '${ORG_A}', 'x', 'B2C Reply', 'b2c', 'rejected', (select body from public.enquiry_messages where id = '${m}'), '{"kind":"b2c_reply"}')`);
    expect(await newDb.err(STAFF, `update public.enquiry_messages set status = 'pending_approval', approval_id = '${wrongText}' where id = '${m}'`)).toMatch(/differs from the approval/);
    expect(await newDb.err(STAFF, `update public.enquiry_messages set status = 'pending_approval', approval_id = '${notPending}' where id = '${m}'`)).toMatch(/not pending/);
  });

  it("a viewer and another organisation's owner can change nothing", async () => {
    const { m } = await draft(newDb);
    await newDb.as(VIEWER, () => newDb.db.query(`update public.enquiry_messages set body = 'viewer edit' where id = '${m}'`));
    await newDb.as(OWNER_B, () => newDb.db.query(`update public.enquiry_messages set body = 'foreign edit' where id = '${m}'`));
    expect((await newDb.rows(`select body from public.enquiry_messages where id = '${m}'`))[0].body).not.toMatch(/edit/);
  });

  it("every legitimate foreign-key action still works with the guards in place: deleting a product, a customer or an enquiry, and deleting a user", async () => {
    const e = uid(newDb, 1), m = uid(newDb, 2), p = uid(newDb, 4), c = uid(newDb, 5), u = uid(newDb, 6);
    await newDb.db.exec(`
      insert into auth.users (id, raw_user_meta_data) values ('${u}', '{}');
      insert into public.memberships (org_id, user_id, role) values ('${ORG_A}', '${u}', 'staff');
      insert into public.products (id, org_id, sku, name) values ('${p}', '${ORG_A}', 'FK-1', 'FK product');
      insert into public.customers (id, org_id, name) values ('${c}', '${ORG_A}', 'FK customer');
      insert into public.enquiries (id, org_id, subject, product_id, customer_id) values ('${e}', '${ORG_A}', 'fk', '${p}', '${c}');
      insert into public.enquiry_messages (id, org_id, enquiry_id, direction, body, status, product_id) values ('${m}', '${ORG_A}', '${e}', 'outbound', 'reply', 'draft', '${p}');`);
    await newDb.as(u, () => newDb.db.query(`insert into public.enquiry_messages (org_id, enquiry_id, direction, body) values ('${ORG_A}', '${e}', 'inbound', 'by the user')`));
    await newDb.as(OWNER, async () => { await newDb.db.query(`delete from public.products where id = '${p}'`); await newDb.db.query(`delete from public.customers where id = '${c}'`); });
    expect((await newDb.rows(`select product_id, customer_id from public.enquiries where id = '${e}'`))[0]).toEqual({ product_id: null, customer_id: null });
    expect((await newDb.rows(`select product_id from public.enquiry_messages where id = '${m}'`))[0].product_id).toBeNull();
    await newDb.db.exec(`delete from public.memberships where user_id = '${u}'; delete from auth.users where id = '${u}'`); // created_by is set to null by the foreign key
    expect((await newDb.rows(`select created_by from public.enquiry_messages where body = 'by the user'`))[0].created_by).toBeNull();
    expect(await newDb.err(OWNER, `delete from public.enquiries where id = '${e}'`)).toMatch(/cannot be deleted/); // conversations are kept (D2)
    expect((await newDb.rows(`select 1 from public.enquiry_messages where enquiry_id = '${e}'`)).length).toBeGreaterThan(0);
  });
});

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe("M3: approved content and stored content cannot diverge; status is derived", () => {
  let w: World;
  beforeAll(async () => { w = await boot(MIGRATION); });
  afterAll(async () => { await w.db.close(); });
  const long = (n: number) => `${"Thank you for writing to Cheri & Co. ".repeat(Math.ceil(n / 36)).slice(0, n - 1)}.`;

  it("an approver's edit of 5800 characters (past the old 2000 limit) is copied onto the message, and approving keeps the two texts identical", async () => {
    const { e, m } = await draft(w);
    const a = await submitByHand(w, m);
    const text = long(5800);
    await decide(w, a, "edit", lit(text));
    expect((await w.rows(`select body from public.enquiry_messages where id = '${m}'`))[0].body).toBe(text);
    await decide(w, a, "approve");
    const row = (await w.rows(`select m.status, m.body = a.preview as same from public.enquiry_messages m join public.approvals a on a.id = m.approval_id where m.id = '${m}'`))[0];
    expect(row).toEqual({ status: "approved", same: true });
    expect((await w.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("approved");
  });
  it("a text longer than the approval allows (6001) is refused by the table, not truncated", async () => {
    const { m } = await draft(w);
    expect(await w.err(STAFF, `update public.enquiry_messages set body = ${lit(long(6001))} where id = '${m}'`)).toMatch(/check constraint/);
  });
  it("the enquiry status follows the latest reply through every step and cannot be set by hand, but a person can close and reopen", async () => {
    const { e, m } = await draft(w);
    const status = async () => (await w.rows(`select status from public.enquiries where id = '${e}'`))[0].status;
    expect(await status()).toBe("draft_ready"); // the draft insert already re-derived the status (it was "new" with only the customer's message)
    const a = await submitByHand(w, m);
    expect(await status()).toBe("awaiting_approval");
    await decide(w, a, "reject");
    expect(await status()).toBe("draft_ready");
    expect(await w.err(STAFF, `update public.enquiries set status = 'approved' where id = '${e}'`)).toMatch(/follows the replies/);
    expect(await w.err(STAFF, `update public.enquiries set status = 'closed' where id = '${e}'`)).toBeNull();
    expect(await status()).toBe("closed");
    expect(await w.err(STAFF, `update public.enquiries set status = 'replied' where id = '${e}'`)).toMatch(/follows the replies/); // reopen only to what the replies imply
    expect(await w.err(STAFF, `update public.enquiries set status = 'draft_ready' where id = '${e}'`)).toBeNull();
    expect(await status()).toBe("draft_ready");
  });
  it("an enquiry cannot be closed while a reply waits for a decision, and a closed enquiry stays closed when a decision lands", async () => {
    const { e, m } = await draft(w);
    const a = await submitByHand(w, m);
    expect(await w.err(STAFF, `update public.enquiries set status = 'closed' where id = '${e}'`)).toMatch(/waiting for a decision/);
    await decide(w, a, "reject");
    await w.err(STAFF, `update public.enquiries set status = 'closed' where id = '${e}'`);
    expect((await w.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("closed");
  });
});

describe("M2: atomic submit (submit_b2c_reply) and atomic creation (create_b2c_enquiry)", () => {
  let w: World;
  beforeAll(async () => { w = await boot(MIGRATION); });
  afterAll(async () => { await w.db.close(); });
  const submit = (e: string, m: string, body: string) => w.as(STAFF, () => w.db.query<{ id: string; preview: string }>(`select * from public.submit_b2c_reply('${ORG_A}', '${e}', '${m}', ${lit(body)}, 'Reply', 'subject')`)).then((r) => r.rows[0]);
  const submitErr = async (e: string, m: string, body: string) => { try { await submit(e, m, body); return null; } catch (x) { return (x as Error).message; } };
  const bodyOf = async (m: string) => (await w.rows(`select body from public.enquiry_messages where id = '${m}'`))[0].body as string;

  it("repeating a submit (retry, double click) returns the same approval and creates nothing", async () => {
    const { e, m } = await draft(w);
    const body = await bodyOf(m);
    const first = await submit(e, m, body);
    for (let i = 0; i < 3; i++) expect((await submit(e, m, body)).id).toBe(first.id);
    expect((await w.rows(`select 1 from public.approvals where meta->>'messageId' = '${m}'`)).length).toBe(1);
  });
  it("submits issued together (serialised by PGlite) still produce exactly one approval", async () => {
    const { e, m } = await draft(w);
    const body = await bodyOf(m);
    const ids = await Promise.all([submit(e, m, body), submit(e, m, body), submit(e, m, body)]);
    expect(new Set(ids.map((x) => x.id)).size).toBe(1);
    expect((await w.rows(`select 1 from public.approvals where meta->>'messageId' = '${m}'`)).length).toBe(1);
  });
  it("a submit that reviewed older wording fails and creates no approval (an edit won the race)", async () => {
    const { e, m } = await draft(w);
    const reviewed = await bodyOf(m);
    await w.as(STAFF, () => w.db.query(`update public.enquiry_messages set body = 'Edited after the reviewer looked.' where id = '${m}'`));
    expect(await submitErr(e, m, reviewed)).toMatch(/draft changed/);
    expect((await w.rows(`select 1 from public.approvals where meta->>'messageId' = '${m}'`)).length).toBe(0);
    expect(await submit(e, m, 'Edited after the reviewer looked.')).toMatchObject({ preview: "Edited after the reviewer looked." });
  });
  it("once submitted, an edit is refused, so the approval text can never differ from the stored text", async () => {
    const { e, m } = await draft(w);
    const a = await submit(e, m, await bodyOf(m));
    expect(await w.err(STAFF, `update public.enquiry_messages set body = 'late edit' where id = '${m}'`)).toMatch(/cannot be edited/);
    expect((await w.rows(`select m.body = a.preview as same from public.enquiry_messages m, public.approvals a where m.id = '${m}' and a.id = '${a.id}'`))[0].same).toBe(true);
  });
  it("a submit of a message that is approved, rejected, someone else's, or inbound is refused", async () => {
    const x = await approvedMessage(w, false);
    expect(await submitErr(x.e, x.m, await bodyOf(x.m))).toMatch(/invalid state/);
    const r = await draft(w);
    const ra = await submitByHand(w, r.m);
    await decide(w, ra, "reject");
    expect(await submitErr(r.e, r.m, await bodyOf(r.m))).toMatch(/invalid state/);
    const d = await draft(w);
    expect(await submitErr(d.e, uid(w, 9), "x")).toMatch(/not found/);
    const inbound = (await w.rows(`select id from public.enquiry_messages where enquiry_id = '${d.e}' and direction = 'inbound'`))[0].id;
    expect(await submitErr(d.e, inbound, "x")).toMatch(/not found/);
  });
  it("a viewer cannot submit, and another organisation cannot see the message", async () => {
    const { e, m } = await draft(w);
    const body = await bodyOf(m);
    const asViewer = await w.as(VIEWER, async () => { try { await w.db.query(`select public.submit_b2c_reply('${ORG_A}', '${e}', '${m}', ${lit(body)}, 'x', 'x')`); return null; } catch (x) { return (x as Error).message; } });
    expect(asViewer).toBeTruthy();
    const asOther = await w.as(OWNER_B, async () => { try { await w.db.query(`select public.submit_b2c_reply('${ORG_A}', '${e}', '${m}', ${lit(body)}, 'x', 'x')`); return null; } catch (x) { return (x as Error).message; } });
    expect(asOther).toMatch(/not found/);
    expect((await w.rows(`select 1 from public.approvals where meta->>'messageId' = '${m}'`)).length).toBe(0);
  });
  it("create_b2c_enquiry makes the enquiry and its message together, and the same message again returns the existing enquiry", async () => {
    const call = () => w.as(STAFF, () => w.db.query<{ create_b2c_enquiry: { id: string; duplicate: boolean } }>(`select public.create_b2c_enquiry('${ORG_A}', 'instagram', null, null, 'Hoops?', 'Atomic hoops enquiry')`)).then((r) => r.rows[0].create_b2c_enquiry);
    const [a, b, c] = await Promise.all([call(), call(), call()]);
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, true, true]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect((await w.rows(`select count(*)::int as n from public.enquiry_messages where body = 'Atomic hoops enquiry'`))[0].n).toBe(1);
    expect((await w.rows(`select created_by, status from public.enquiries where id = '${a.id}'`))[0]).toEqual({ created_by: STAFF, status: "new" });
  });
  it("create_b2c_enquiry rolls back as one: a bad product leaves no enquiry behind", async () => {
    const before = (await w.rows("select count(*)::int as n from public.enquiries"))[0].n;
    const msg = await w.as(STAFF, async () => { try { await w.db.query(`select public.create_b2c_enquiry('${ORG_A}', 'instagram', null, '${uid(w, 7)}', 's', 'orphan?')`); return null; } catch (x) { return (x as Error).message; } });
    expect(msg).toMatch(/foreign key/);
    expect((await w.rows("select count(*)::int as n from public.enquiries"))[0].n).toBe(before);
  });
});

describe("M4: one live reply per enquiry (partial unique index); history is not blocked", () => {
  let w: World;
  beforeAll(async () => { w = await boot(MIGRATION); });
  afterAll(async () => { await w.db.close(); });
  const addDraft = (sub: string, e: string) => w.err(sub, `insert into public.enquiry_messages (org_id, enquiry_id, direction, body, status) values ('${ORG_A}', '${e}', 'outbound', 'another', 'draft')`);

  it("a second draft or pending reply is refused with a unique violation; the first is untouched", async () => {
    const { e } = await draft(w);
    expect(await addDraft(STAFF, e)).toMatch(/enquiry_messages_one_live_reply|duplicate key/);
    expect((await w.rows(`select 1 from public.enquiry_messages where enquiry_id = '${e}' and direction = 'outbound'`)).length).toBe(1);
  });
  it("simultaneous creation attempts (serialised by PGlite) leave exactly one draft and the loser gets the unique violation", async () => {
    const e = uid(w, 1);
    await w.db.exec(`insert into public.enquiries (id, org_id, subject) values ('${e}', '${ORG_A}', 's')`);
    const results = await Promise.all([addDraft(STAFF, e), addDraft(STAFF, e), addDraft(OWNER, e)]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r && /duplicate key|one_live_reply/.test(r))).toHaveLength(2);
    expect((await w.rows(`select 1 from public.enquiry_messages where enquiry_id = '${e}' and direction = 'outbound'`)).length).toBe(1);
  });
  it("rejected, approved and sent replies are history and never block a new draft; several can accumulate", async () => {
    const { e, m } = await draft(w);
    const a = await submitByHand(w, m);
    await decide(w, a, "reject");
    expect(await addDraft(STAFF, e)).toBeNull(); // the rejected one no longer counts
    const second = (await w.rows(`select id from public.enquiry_messages where enquiry_id = '${e}' and status = 'draft'`))[0].id as string;
    const a2 = await submitByHand(w, second);
    await decide(w, a2, "approve");
    expect(await addDraft(STAFF, e)).toBeNull(); // approved counts as history too
    await w.as(STAFF, () => w.db.query(`update public.enquiry_messages set status = 'sent_manually' where id = '${second}'`));
    expect((await w.rows(`select status from public.enquiry_messages where enquiry_id = '${e}' and direction = 'outbound' order by created_at, id`)).map((r) => r.status).sort()).toEqual(["draft", "rejected", "sent_manually"]);
  });
  it("a draft that is pending blocks a new one, and a decided reply releases the slot", async () => {
    const { e, m } = await draft(w);
    const a = await submitByHand(w, m);
    expect(await addDraft(STAFF, e)).toMatch(/duplicate key|one_live_reply/);
    await decide(w, a, "approve");
    expect(await addDraft(STAFF, e)).toBeNull();
  });
});

describe("migration extras: indexes, updated_at, created_by, comments, rollback", () => {
  let w: World;
  beforeAll(async () => { w = await boot(MIGRATION); });
  afterAll(async () => { await w.db.close(); });

  it("every foreign key on the two tables has a covering index (leading columns), and no two indexes are identical", async () => {
    const fks = await w.rows(`select c.conname, c.conrelid::regclass::text as tbl, c.conkey as cols from pg_constraint c where c.contype = 'f' and c.conrelid in ('public.enquiries'::regclass, 'public.enquiry_messages'::regclass)`);
    expect(fks.length).toBeGreaterThanOrEqual(8);
    for (const fk of fks) {
      const covered = await w.rows(`select 1 from pg_index i where i.indrelid = '${fk.tbl}'::regclass and (i.indkey::int2[])[0:${fk.cols.length - 1}] = array[${fk.cols.join(",")}]::int2[]`);
      expect(covered.length, `${fk.tbl} ${fk.conname}`).toBeGreaterThan(0);
    }
    const dupes = await w.rows(`select indrelid::regclass::text t, indkey::text k, coalesce(pg_get_expr(indpred, indrelid), '') p, count(*) from pg_index where indrelid in ('public.enquiries'::regclass, 'public.enquiry_messages'::regclass) group by 1, 2, 3 having count(*) > 1`);
    expect(dupes).toEqual([]);
  });
  it("updated_at is maintained on every update; created_by is the real user on insert and cannot be re-pointed", async () => {
    const e = uid(w, 1);
    await w.as(STAFF, () => w.db.query(`insert into public.enquiries (id, org_id, subject, created_by) values ('${e}', '${ORG_A}', 's', '${APPROVER}')`));
    const first = (await w.rows(`select created_by, updated_at, created_at from public.enquiries where id = '${e}'`))[0];
    expect(first.created_by).toBe(STAFF);
    await w.db.exec("select pg_sleep(0.05)");
    await w.as(STAFF, () => w.db.query(`update public.enquiries set subject = 'renamed' where id = '${e}'`));
    const second = (await w.rows(`select updated_at from public.enquiries where id = '${e}'`))[0];
    expect(new Date(second.updated_at).getTime()).toBeGreaterThan(new Date(first.updated_at).getTime());
    expect(await w.err(STAFF, `update public.enquiries set created_by = '${APPROVER}', updated_at = '2001-01-01' where id = '${e}'`)).toMatch(/cannot be changed/);
    expect(await w.err(STAFF, `update public.enquiries set created_at = '2001-01-01' where id = '${e}'`)).toMatch(/cannot be changed/);
  });
  it("the header no longer carries the stale follow-up reference and documents the rollback and what the feature leaves behind", () => {
    expect(MIGRATION).not.toMatch(/related_ref = 'enquiry:<id>'/);
    expect(MIGRATION).toMatch(/related_ref = '\/b2c\?enquiry=<enquiry id>'/);
    for (const word of ["ROLLBACK", "B2C Reply", "tasks where source = 'B2C enquiry'", "agent_activity", "customers created from an enquiry"]) expect(MIGRATION).toContain(word);
  });
  it("the documented rollback statements run cleanly and remove everything the migration added", async () => {
    const fresh = await boot(MIGRATION);
    const stmts = MIGRATION.split("\n").filter((l) => /^--   drop /.test(l)).map((l) => l.replace(/^--   /, ""));
    expect(stmts.length).toBeGreaterThanOrEqual(6);
    for (const s of stmts) await fresh.db.exec(s);
    expect((await fresh.rows("select to_regclass('public.enquiries') a, to_regclass('public.enquiry_messages') b"))[0]).toEqual({ a: null, b: null });
    expect((await fresh.rows("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.proname in ('submit_b2c_reply','create_b2c_enquiry','guard_enquiry_message','guard_enquiry','refresh_enquiry_status','enquiry_derived_status','sync_b2c_reply','guard_enquiry_message_delete','guard_enquiry_delete')"))[0].n).toBe(0);
    expect((await fresh.rows("select count(*)::int n from pg_trigger where tgname = 'b2c_reply_sync'"))[0].n).toBe(0);
    await fresh.db.close();
  });
  it("only the approvals trigger touches an existing table, and it is limited to reply approvals (no other approval type is affected)", async () => {
    expect((await w.rows("select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'public.approvals'::regclass and not tgisinternal")).map((r) => r.tgname)).toEqual(["b2c_reply_sync"]);
    const a = uid(w, 3);
    await w.db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${a}', '${ORG_A}', 'content', 'Content', 'content', 'text')`);
    await decide(w, a, "approve"); // an ordinary approval is decided exactly as before
    expect((await w.rows(`select status from public.approvals where id = '${a}'`))[0].status).toBe("approved");
  });
});

const ADMIN = "11111111-0000-0000-0000-000000000007";
const HELPERS = ["private.enquiry_derived_status(uuid)", "private.refresh_enquiry_status()", "private.guard_enquiry()", "private.guard_enquiry_message()",
  "private.guard_enquiry_message_delete()", "private.guard_enquiry_delete()", "private.sync_b2c_reply()"];

describe("D1: internal helpers are not callable by application users", () => {
  let w: World;
  beforeAll(async () => {
    w = await boot(MIGRATION);
    await w.db.exec(`insert into auth.users (id, raw_user_meta_data) values ('${ADMIN}','{}'); insert into public.memberships (org_id, user_id, role) values ('${ORG_A}','${ADMIN}','admin');`);
  });
  afterAll(async () => { await w.db.close(); });

  it("no helper has EXECUTE for PUBLIC, anon or authenticated; the two RPCs keep authenticated only", async () => {
    for (const fn of HELPERS) {
      const r = (await w.rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u, (select count(*)::int from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = '${fn}'::regprocedure and x.grantee = 0) pub`))[0];
      expect(r, fn).toEqual({ a: false, u: false, pub: 0 });
    }
    for (const fn of ["public.submit_b2c_reply(uuid, uuid, uuid, text, text, text)", "public.create_b2c_enquiry(uuid, text, uuid, uuid, text, text)"]) {
      const r = (await w.rows(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') u`))[0];
      expect(r, fn).toEqual({ a: false, u: true });
    }
  });
  it("organisation A cannot call a helper to read organisation B's enquiry status", async () => {
    const eb = uid(w, 1);
    await w.db.exec(`insert into public.enquiries (id, org_id, subject) values ('${eb}', '${ORG_B}', 'secret'); insert into public.enquiry_messages (org_id, enquiry_id, direction, body, status, generated_by) values ('${ORG_B}', '${eb}', 'outbound', 'b reply', 'draft', 'template')`);
    expect(await w.rows(`select 1 from public.enquiries where id = '${eb}'`)).toHaveLength(1); // the table owner sees it, so the checks below are meaningful
    for (const who of [STAFF, OWNER, APPROVER, VIEWER, ADMIN]) {
      expect(await w.err(who, `select private.enquiry_derived_status('${eb}')`), who).toMatch(/permission denied for function/);
      expect(await w.as(who, () => w.rows(`select id from public.enquiries where id = '${eb}'`)), who).toEqual([]);
    }
    for (const fn of ["select private.refresh_enquiry_status()", "select private.sync_b2c_reply()", "select private.guard_enquiry()", "select private.guard_enquiry_message()", "select private.guard_enquiry_delete()", "select private.guard_enquiry_message_delete()"]) {
      expect(await w.err(STAFF, fn), fn).toMatch(/permission denied for function/);
    }
    // the owner of organisation B can still use their own enquiry normally
    expect(await w.err(OWNER_B, `update public.enquiries set subject = 'renamed' where id = '${eb}'`)).toBeNull();
  });
  it("anon is stopped one step earlier (no access to the private schema)", async () => {
    await w.db.exec("set role anon");
    try { await expect(w.db.query("select private.enquiry_derived_status(gen_random_uuid())")).rejects.toThrow(/permission denied/); } finally { await w.db.exec("reset role"); }
  });
  it("triggers and the RPCs still work with the helpers locked: status derivation, the approvals sync, and both RPCs run as ordinary users", async () => {
    const { e, m } = await draft(w);
    const sub = await w.as(STAFF, () => w.db.query<{ id: string }>(`select * from public.submit_b2c_reply('${ORG_A}', '${e}', '${m}', (select body from public.enquiry_messages where id = '${m}'), 'Reply', 's')`));
    expect((await w.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("awaiting_approval"); // refresh trigger -> enquiry_derived_status
    await decide(w, sub.rows[0].id, "approve"); // approvals trigger -> messages guard -> refresh
    expect((await w.rows(`select status from public.enquiry_messages where id = '${m}'`))[0].status).toBe("approved");
    expect((await w.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("approved");
    expect(await w.err(STAFF, `update public.enquiry_messages set status = 'sent_manually' where id = '${m}'`)).toBeNull();
    expect((await w.rows(`select status from public.enquiries where id = '${e}'`))[0].status).toBe("replied");
    const created = await w.as(STAFF, () => w.db.query<{ r: { duplicate: boolean } }>(`select public.create_b2c_enquiry('${ORG_A}', 'email', null, null, 's', 'D1 helper test message') r`));
    expect(created.rows[0].r.duplicate).toBe(false);
    expect(await w.err(STAFF, `update public.enquiries set status = 'closed' where id = '${e}'`)).toBeNull(); // guard_enquiry -> enquiry_derived_status path on reopen
    expect(await w.err(STAFF, `update public.enquiries set status = 'replied' where id = '${e}'`)).toBeNull();
  });
  it("the schema grants are as expected: authenticated has USAGE on private (the RLS helpers need it), anon has none", async () => {
    const r = (await w.rows("select has_schema_privilege('authenticated', 'private', 'usage') u, has_schema_privilege('anon', 'private', 'usage') a"))[0];
    expect(r).toEqual({ u: true, a: false });
  });
});

describe("D2: enquiry conversations cannot be hard-deleted", () => {
  let w: World;
  beforeAll(async () => {
    w = await boot(MIGRATION);
    await w.db.exec(`insert into auth.users (id, raw_user_meta_data) values ('${ADMIN}','{}'); insert into public.memberships (org_id, user_id, role) values ('${ORG_A}','${ADMIN}','admin');`);
  });
  afterAll(async () => { await w.db.close(); });
  const GONE = /cannot be deleted.*(Close the enquiry instead|approval history)/;
  /** An enquiry with an inbound message, and an outbound reply taken to the given stage through the real flow. */
  async function convo(stage: "draft" | "pending" | "approved" | "sent"): Promise<{ e: string; m: string; a: string | null; inbound: string }> {
    const { e, m } = await draft(w);
    const inbound = (await w.rows(`select id from public.enquiry_messages where enquiry_id = '${e}' and direction = 'inbound'`))[0].id as string;
    if (stage === "draft") return { e, m, a: null, inbound };
    const a = await submitByHand(w, m);
    if (stage === "approved" || stage === "sent") await decide(w, a, "approve");
    if (stage === "sent") await w.as(STAFF, () => w.db.query(`update public.enquiry_messages set status = 'sent_manually' where id = '${m}'`));
    return { e, m, a, inbound };
  }
  const intact = async (x: { e: string; m: string; a: string | null; inbound: string }) => {
    expect((await w.rows(`select count(*)::int n from public.enquiry_messages where enquiry_id = '${x.e}'`))[0].n).toBe(2);
    expect((await w.rows(`select 1 from public.enquiries where id = '${x.e}'`)).length).toBe(1);
    if (x.a) {
      const ap = (await w.rows(`select status from public.approvals where id = '${x.a}'`))[0];
      expect(ap).toBeTruthy();
      expect((await w.rows(`select 1 from public.enquiry_messages where id = '${x.m}' and approval_id = '${x.a}'`)).length).toBe(1);
    }
  };

  it("an owner cannot delete an inbound customer message", async () => { const x = await convo("pending"); expect(await w.err(OWNER, `delete from public.enquiry_messages where id = '${x.inbound}'`)).toMatch(GONE); await intact(x); });
  it("an admin cannot delete an inbound customer message", async () => { const x = await convo("draft"); expect(await w.err(ADMIN, `delete from public.enquiry_messages where id = '${x.inbound}'`)).toMatch(GONE); await intact(x); });
  it("an owner cannot delete an approved reply, and the approval and its audit row are untouched", async () => {
    const x = await convo("approved");
    expect(await w.err(OWNER, `delete from public.enquiry_messages where id = '${x.m}'`)).toMatch(GONE);
    await intact(x);
    expect((await w.rows(`select count(*)::int n from public.audit_log where approval_id = '${x.a}'`))[0].n).toBe(1);
  });
  it("an admin cannot delete a pending reply (so no approval is ever stranded)", async () => {
    const x = await convo("pending");
    expect(await w.err(ADMIN, `delete from public.enquiry_messages where id = '${x.m}'`)).toMatch(GONE);
    await intact(x);
    expect((await w.rows(`select status from public.approvals where id = '${x.a}'`))[0].status).toBe("pending");
    expect((await w.rows(`select status from public.enquiries where id = '${x.e}'`))[0].status).toBe("awaiting_approval");
  });
  it("a sent reply cannot be deleted either; a bulk delete of all of an enquiry's messages is refused as a whole", async () => {
    const x = await convo("sent");
    expect(await w.err(OWNER, `delete from public.enquiry_messages where id = '${x.m}'`)).toMatch(GONE);
    expect(await w.err(OWNER, `delete from public.enquiry_messages where enquiry_id = '${x.e}'`)).toMatch(GONE);
    await intact(x);
  });
  it("an enquiry that has messages cannot be deleted by an owner or an admin; its messages and approval survive", async () => {
    const x = await convo("pending");
    for (const who of [OWNER, ADMIN]) expect(await w.err(who, `delete from public.enquiries where id = '${x.e}'`), who).toMatch(/cannot be deleted/);
    await intact(x);
  });
  it("staff, approver, viewer and another organisation delete nothing (row level security), and the table owner is stopped too", async () => {
    const x = await convo("approved");
    for (const who of [STAFF, APPROVER, VIEWER, OWNER_B]) {
      expect(await w.err(who, `delete from public.enquiry_messages where id = '${x.m}'`), who).toBeNull(); // 0 rows: policy filters them out
      expect(await w.err(who, `delete from public.enquiries where id = '${x.e}'`), who).toBeNull();
    }
    await intact(x);
    await expect(w.db.query(`delete from public.enquiry_messages where id = '${x.m}'`)).rejects.toThrow(GONE); // even a superuser connection
    await expect(w.db.query(`delete from public.enquiries where id = '${x.e}'`)).rejects.toThrow(/cannot be deleted/);
    await intact(x);
  });
  it("an enquiry with no messages at all can still be deleted by an owner (nothing is lost)", async () => {
    const e = uid(w, 1);
    await w.db.exec(`insert into public.enquiries (id, org_id, subject) values ('${e}', '${ORG_A}', 'empty')`);
    expect(await w.err(OWNER, `delete from public.enquiries where id = '${e}'`)).toBeNull();
    expect((await w.rows(`select 1 from public.enquiries where id = '${e}'`)).length).toBe(0);
  });
  it("close and reopen still work as the lifecycle, and history stays intact through them", async () => {
    const x = await convo("approved");
    expect(await w.err(STAFF, `update public.enquiries set status = 'closed' where id = '${x.e}'`)).toBeNull();
    expect((await w.rows(`select status from public.enquiries where id = '${x.e}'`))[0].status).toBe("closed");
    expect(await w.err(STAFF, `update public.enquiries set status = 'approved' where id = '${x.e}'`)).toBeNull(); // reopen to what the latest reply implies
    expect((await w.rows(`select status from public.enquiries where id = '${x.e}'`))[0].status).toBe("approved");
    await intact(x);
  });
  it("deleting a product, a customer or a user still works (set null), and the messages remain", async () => {
    const e = uid(w, 1), p = uid(w, 4), c = uid(w, 5);
    await w.db.exec(`insert into public.products (id, org_id, sku, name) values ('${p}', '${ORG_A}', 'D2-1', 'D2 product'); insert into public.customers (id, org_id, name) values ('${c}', '${ORG_A}', 'D2 customer');
      insert into public.enquiries (id, org_id, subject, product_id, customer_id) values ('${e}', '${ORG_A}', 'fk', '${p}', '${c}');
      insert into public.enquiry_messages (org_id, enquiry_id, direction, body, product_id) values ('${ORG_A}', '${e}', 'inbound', 'hello', '${p}');`);
    expect(await w.err(OWNER, `delete from public.products where id = '${p}'`)).toBeNull();
    expect(await w.err(OWNER, `delete from public.customers where id = '${c}'`)).toBeNull();
    expect((await w.rows(`select count(*)::int n from public.enquiry_messages where enquiry_id = '${e}'`))[0].n).toBe(1);
  });
  it("deleting a whole organisation still works (the only exception): everything it owns is removed by cascade, other organisations are untouched", async () => {
    const orgX = "cccccccc-0000-0000-0000-0000000000cc", e = uid(w, 1), m = uid(w, 2);
    await w.db.exec(`insert into public.organizations (id, name) values ('${orgX}', 'Temp'); insert into public.enquiries (id, org_id, subject) values ('${e}', '${orgX}', 's');
      insert into public.enquiry_messages (org_id, enquiry_id, direction, body) values ('${orgX}', '${e}', 'inbound', 'hello');
      insert into public.enquiry_messages (id, org_id, enquiry_id, direction, body, status, generated_by) values ('${m}', '${orgX}', '${e}', 'outbound', 'reply', 'draft', 'template');`);
    const keep = (await w.rows("select count(*)::int n from public.enquiry_messages where org_id = '" + ORG_A + "'"))[0].n;
    await w.db.exec(`delete from public.organizations where id = '${orgX}'`);
    expect((await w.rows(`select count(*)::int n from public.enquiries where org_id = '${orgX}'`))[0].n).toBe(0);
    expect((await w.rows(`select count(*)::int n from public.enquiry_messages where org_id = '${orgX}'`))[0].n).toBe(0);
    expect((await w.rows("select count(*)::int n from public.enquiry_messages where org_id = '" + ORG_A + "'"))[0].n).toBe(keep);
  });
  it("the error is plain and safe: it names the rule and the alternative, and leaks no identifiers", async () => {
    const x = await convo("draft");
    const msg = (await w.err(OWNER, `delete from public.enquiry_messages where id = '${x.m}'`)) ?? "";
    expect(msg).toBe("Enquiry messages cannot be deleted: the conversation and its approval history are kept. Close the enquiry instead.");
    const msg2 = (await w.err(OWNER, `delete from public.enquiries where id = '${x.e}'`)) ?? "";
    expect(msg2).toBe("An enquiry that has messages cannot be deleted: the conversation and its approval history are kept. Close the enquiry instead.");
  });
});
