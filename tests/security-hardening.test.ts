/** Database security tests for supabase/migrations/20261104000000_security_hardening.sql.
 *
 *  WHAT THIS IS: real SQL (the real foundation + hardening migrations) run in an in-process Postgres (PGlite). The Supabase pieces
 *  the migrations rely on (auth.users, auth.uid(), the anon/authenticated/service_role roles) are stubbed. A signed-in request is
 *  emulated with `set role authenticated` plus a JWT subject setting.
 *  WHAT THIS IS NOT: it is not the hosted Supabase service, and PGlite has a single connection, so true concurrent sessions are
 *  not exercised here (that check is in docs/STAGING_SETUP_AND_VERIFICATION.md). Nothing here is hosted verification. */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAIM_NORMALISATION, CLAIM_RULES, findProhibitedClaims, normalizeClaimText } from "@/lib/content-agent/claims";
import { renderPostForApproval } from "@/lib/social/posts";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const U = {
  ownerA: "11111111-0000-0000-0000-000000000001", adminA: "11111111-0000-0000-0000-000000000002",
  approverA: "11111111-0000-0000-0000-000000000003", staffA: "11111111-0000-0000-0000-000000000004",
  viewerA: "11111111-0000-0000-0000-000000000005", ownerB: "22222222-0000-0000-0000-000000000001",
  staffB: "22222222-0000-0000-0000-000000000002", loner: "33333333-0000-0000-0000-000000000001",
};
const HARDENING = readFileSync("supabase/migrations/20261104000000_security_hardening.sql", "utf8");

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
async function as<T>(sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.sub', '${sub ?? ""}', false); set role ${sub ? "authenticated" : "anon"};`);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.sub', '', false);"); }
}
const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
const fails = async (sql: string) => { try { await db.query(sql); return null; } catch (e) { return (e as Error).message; } };
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

let seq = 0;
const uid = (n: number) => `cccccccc-${String(n).padStart(4, "0")}-0000-0000-${String(++seq).padStart(12, "0")}`;

/** A post in ORG_A (or another org), created as the superuser so any status can be seeded. */
async function post(over: { org?: string; status?: string; caption?: string | null; title?: string; hashtags?: string[]; brief?: string | null; image?: string | null; platform?: string } = {}) {
  const id = uid(1);
  const hashtags = `array[${(over.hashtags ?? ["#cheri"]).map(q).join(",")}]::text[]`;
  await db.exec(`insert into public.content_items (id, org_id, platform, title, caption, hashtags, creative_brief, image_direction, status)
    values ('${id}', '${over.org ?? ORG_A}', ${q(over.platform ?? "Instagram")}, ${q(over.title ?? "Spring post")}, ${over.caption === null ? "null" : q(over.caption ?? "A calm look for spring")},
    ${hashtags}, ${over.brief === null ? "null" : q(over.brief ?? "Soft light")}, ${over.image === null ? "null" : q(over.image ?? "Flat lay")}, ${q(over.status ?? "draft")})`);
  return id;
}
const get = async (id: string) => (await rows(`select * from public.content_items where id = '${id}'`))[0];
const approvalOf = async (id: string) => (await rows(`select * from public.approvals where id = '${id}'`))[0];
const counts = async () => ({
  approvals: (await rows("select count(*)::int n from public.approvals"))[0].n as number,
  audit: (await rows("select count(*)::int n from public.audit_log"))[0].n as number,
  activity: (await rows("select count(*)::int n from public.agent_activity"))[0].n as number,
});
/** Submit a clean draft as staff and return both ids. */
async function submitted(over: Parameters<typeof post>[0] = {}) {
  const p = await post(over);
  const a = (await as(U.staffA, () => rows(`select public.submit_content('${p}') as id`)))[0].id as string;
  return { p, a };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(stub);
  await db.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
  await db.exec(HARDENING);
  await db.exec(`
    insert into auth.users (id, raw_user_meta_data) values ${Object.values(U).map((id) => `('${id}', '{}')`).join(",")};
    insert into public.organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into public.memberships (org_id, user_id, role) values
      ('${ORG_A}', '${U.ownerA}', 'owner'), ('${ORG_A}', '${U.adminA}', 'admin'), ('${ORG_A}', '${U.approverA}', 'approver'),
      ('${ORG_A}', '${U.staffA}', 'staff'), ('${ORG_A}', '${U.viewerA}', 'viewer'),
      ('${ORG_B}', '${U.ownerB}', 'owner'), ('${ORG_B}', '${U.staffB}', 'staff');
  `);
});
afterAll(async () => { await db.close(); });

/* ------------------------------------------------------------------ S1 */
describe("S1: the SQL claim rules match the application's rules", () => {
  it("every pattern in claims.ts appears in the migration (only \\b becomes \\y), in the same order, so the copy cannot drift", () => {
    const sqlRules = [...HARDENING.matchAll(/^\s+\((\d+), '(\w+)', '([^']+)', '((?:[^']|'')*)'\),?$/gm)];
    expect(sqlRules).toHaveLength(CLAIM_RULES.length);
    CLAIM_RULES.forEach((r, i) => {
      expect(sqlRules[i][2]).toBe(r.id);
      expect(sqlRules[i][3]).toBe(r.label);
      expect(sqlRules[i][4].replace(/''/g, "'")).toBe(r.source.replaceAll("\\b", "\\y"));
    });
  });

  // one phrase per rule alternative, in several cases and spacings, plus text that must NOT match
  const MUST_MATCH = [
    "Only ₹499 today", "Rs. 299 only", "rs 99", "INR 1,200", "Starting at a low rate", "Starting from Monday", "under ₹500", "under 500", "500 rupees", "USD 20", "$25 off",
    "50% off", "20 % discount", "Big SALE now", "Use this coupon", "promo code SPRING", "Buy 2 get 1", "Limited-time offer", "Limited time deal", "special offer", "FREE shipping", "free gift",
    "In stock now", "Out of stock", "Sold out!", "Only 3 left", "Last 5 pieces", "few pieces left", "Selling fast", "limited stock", "limited edition", "almost gone", "hurry up",
    "Waterproof", "water-resistant", "Sweat proof", "ANTI-TARNISH", "anti tarnish", "tarnish free", "non-tarnish", "rust proof", "Hypoallergenic", "skin safe", "nickel-free", "lead free",
    "allergy free", "fade-proof", "never fades", "Long-lasting", "lifetime wear",
    "Real gold", "genuine silver", "pure diamonds", "authentic platinum", "925 silver", "Sterling silver", "18k", "22 KT", "24 karat", "gold-plated", "silver plated",
    "Certified", "Hallmarked", "hallmark", "best price", "Lowest price", "the cheapest", "Guaranteed", "guarantee", "100%cotton", "best-seller", "bestsellers", "Bestselling", "number one", "#1 pick",
    "Cures acne", "heals", "therapeutic", "anti-allergic",
  ];
  const MUST_NOT = ["A calm look for spring", "Soft light, flat lay", "Handmade with care #cheri", "Pair with a linen shirt", "Rsvp by Friday", "Gold tones in the sunset", "Tarnished memories", "100% cotton shirt"];

  it("finds the same rules and the same matched text as the application for every phrase, in any letter case", async () => {
    const differences: string[] = [];
    for (const phrase of [...MUST_MATCH, ...MUST_NOT, ...MUST_MATCH.map((p) => p.toUpperCase()), ...MUST_MATCH.map((p) => `Intro line.\n${p}, then more words.`)]) {
      const js = findProhibitedClaims(phrase, []).map((v) => `${v.label}: "${v.match}"`.toLowerCase()).sort();
      const sql = ((await rows(`select private.find_prohibited_claims(${q(phrase)}) as hits`))[0].hits as string[]).map((s) => s.toLowerCase()).sort();
      if (JSON.stringify(js) !== JSON.stringify(sql)) differences.push(`${JSON.stringify(phrase)}: js=${JSON.stringify(js)} sql=${JSON.stringify(sql)}`);
    }
    expect(differences).toEqual([]);
  });

  it("every phrase that should match does match, and the plain copy does not (so the parity above is not two empty results)", async () => {
    for (const phrase of MUST_MATCH) expect(findProhibitedClaims(phrase, []).length, phrase).toBeGreaterThan(0);
    for (const phrase of MUST_NOT.slice(0, 7)) expect(findProhibitedClaims(phrase, []), phrase).toEqual([]);
    expect(((await rows("select private.find_prohibited_claims('a calm look') as h"))[0].h as string[])).toEqual([]);
    expect(((await rows("select private.find_prohibited_claims(null) as h"))[0].h as string[])).toEqual([]);
  });

  it("the helper is not callable by signed-in users or visitors", async () => {
    expect(await as(U.ownerA, () => fails("select private.find_prohibited_claims('x')"))).toMatch(/permission denied/);
    expect(await as(null, () => fails("select private.find_prohibited_claims('x')"))).toMatch(/permission denied/);
  });
});

describe("S1: decide_approval enforces the claims whatever the caller sends", () => {
  /** A content approval linked to a pending post, built by the superuser: the shape the OLD client flow produced. */
  async function linked(preview: string, meta: Record<string, unknown> | null, over: Parameters<typeof post>[0] = {}) {
    const p = await post({ status: "pending_approval", ...over });
    const a = uid(2);
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview, meta) values ('${a}', '${over.org ?? ORG_A}', 'T', 'Content', 'content', ${q(preview)}, ${meta ? q(JSON.stringify({ ...meta, postId: p })) : "null"}::jsonb)`);
    await db.exec(`update public.content_items set approval_id = '${a}' where id = '${p}'`);
    return { p, a };
  }

  it("a clean post is approved by an approver, the post follows in the same step, and the audit row names the real actor", async () => {
    const { p, a } = await submitted();
    const before = await counts();
    const r = await as(U.approverA, () => rows(`select status from public.decide_approval('${a}', 'approve', 'ok')`));
    expect(r[0].status).toBe("approved");
    expect((await get(p)).status).toBe("approved");
    expect((await counts()).audit).toBe(before.audit + 1);
    expect((await rows(`select actor_id, action from public.audit_log where approval_id = '${a}'`))).toEqual([{ actor_id: U.approverA, action: "approve" }]);
  });

  it("a direct call cannot approve a price, a discount, a stock claim or a material claim; nothing changes", async () => {
    for (const bad of ["Caption: Only ₹499", "Caption: 50% off", "Caption: selling fast", "Caption: waterproof and anti-tarnish", "Caption: Real gold", "Caption: certified", "Caption: best price", "Caption: cures acne"]) {
      const { p, a } = await linked(bad, { kind: "content_draft", allowedClaims: [] });
      const before = await counts();
      expect(await as(U.ownerA, () => fails(`select public.decide_approval('${a}', 'approve')`)), bad).toMatch(/prohibited claims/);
      expect((await approvalOf(a)).status, bad).toBe("pending");
      expect((await get(p)).status, bad).toBe("pending_approval");
      expect(await counts(), bad).toEqual(before);
    }
  });

  it("is case-insensitive", async () => {
    for (const bad of ["WATERPROOF", "Waterproof", "wAtErPrOoF", "ONLY ₹499", "SALE"]) {
      const { a } = await linked(bad, { kind: "content_draft" });
      expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`)), bad).toMatch(/prohibited claims/);
    }
  });

  it("a forged allowedClaims list does not unlock anything (the database ignores it)", async () => {
    const { a } = await linked("Caption: waterproof and anti-tarnish", { kind: "content_draft", allowedClaims: ["waterproof", "anti-tarnish", "waterproof and anti-tarnish"] });
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/prohibited claims/);
    // and a writer cannot even plant such a list
    expect(await as(U.staffA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('${ORG_A}', 'x', 'Content', 'content', 'p', '{"allowedClaims": ["waterproof"]}')`))).toMatch(/set only by the approval workflow/);
  });

  it("an approver who edits wording into a (not post-linked) content approval cannot then approve it", async () => {
    const a = uid(4);
    await as(U.staffA, () => db.query(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${a}', '${ORG_A}', 'Draft', 'Content', 'content', 'Caption: a calm look')`));
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'edit', null, null, 'Caption: now only ₹99')`));
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/prohibited claims/);
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'edit', null, null, 'Caption: a calm look')`));
    expect((await as(U.approverA, () => rows(`select status from public.decide_approval('${a}', 'approve')`)))[0].status).toBe("approved");
  });

  it("the post's own text is checked too, not only the approval text a writer could set", async () => {
    const p = await post({ status: "pending_approval", caption: "Real gold, only ₹499" });
    const a = uid(2);
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${a}', '${ORG_A}', 'T', 'Content', 'content', 'Caption: harmless')`);
    await db.exec(`update public.content_items set approval_id = '${a}' where id = '${p}'`);
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/prohibited claims/);
  });

  it("rejecting is always allowed, even for a post with prohibited wording", async () => {
    const { p, a } = await linked("Caption: Only ₹499", { kind: "content_draft" });
    expect((await as(U.approverA, () => rows(`select status from public.decide_approval('${a}', 'reject', 'no')`)))[0].status).toBe("rejected");
    expect((await get(p)).status).toBe("rejected");
  });

  it("F2: every approval is scanned, whatever type or generator its writer chose; a clean one of any type still passes", async () => {
    const id = uid(3);
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview, meta) values ('${id}', '${ORG_A}', 'Reply', 'B2C reply', 'b2c', 'The bracelet is ₹499, 50% off, waterproof', '{"kind":"b2c_reply"}')`);
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${id}', 'approve')`))).toMatch(/prohibited claims/);
    expect((await approvalOf(id)).status).toBe("pending");
    await as(U.approverA, () => db.query(`select public.decide_approval('${id}', 'reject')`)); // rejecting is always possible
    expect((await approvalOf(id)).status).toBe("rejected");
    const clean = uid(3);
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview, meta) values ('${clean}', '${ORG_A}', 'Reply', 'B2C reply', 'b2c', 'Thank you for your message, we will reply soon', null)`);
    expect((await as(U.approverA, () => rows(`select status from public.decide_approval('${clean}', 'approve')`)))[0].status).toBe("approved");
  });

  it("roles are unchanged: only owner, admin and approver decide; staff, viewer, strangers and visitors cannot", async () => {
    for (const [u, expected] of [[U.staffA, /not authorized/], [U.viewerA, /not authorized/], [U.staffB, /not found/], [U.loner, /not found/]] as const) {
      const { a } = await submitted();
      expect(await as(u, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(expected);
    }
    const { a } = await submitted();
    expect(await as(null, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/permission denied/);
    for (const u of [U.ownerA, U.adminA, U.approverA]) {
      const s = await submitted();
      expect((await as(u, () => rows(`select status from public.decide_approval('${s.a}', 'approve')`)))[0].status).toBe("approved");
    }
  });

  it("an approval cannot be decided twice, and the audit history is still append-only", async () => {
    const { a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'approve')`));
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'reject')`))).toMatch(/already decided/);
    expect(await fails("update public.audit_log set note = 'x'")).toMatch(/append-only/);
  });
});

/* ------------------------------------------------------------------ S2 */
describe("S2: content cannot be changed around the approval workflow", () => {
  it("staff cannot set the status or the approval link directly, in either direction", async () => {
    const p = await post();
    const other = await post();
    for (const set of ["status = 'approved'", "status = 'published'", "status = 'pending_approval'", "status = 'rejected'"]) {
      expect(await as(U.staffA, () => fails(`update public.content_items set ${set} where id = '${p}'`)), set).toMatch(/only through submit_content/);
    }
    const { a } = await submitted();
    expect(await as(U.staffA, () => fails(`update public.content_items set approval_id = '${a}' where id = '${other}'`))).toMatch(/only through submit_content/);
    expect(await as(U.staffA, () => fails(`update public.content_items set status = 'draft', approval_id = null where id = '${p}'`))).toBeNull(); // no change at all is fine
  });

  it("an approved post pointed at another post's approved approval stays unchanged and cannot be re-pointed", async () => {
    const { p, a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'approve')`));
    const other = await post();
    expect(await as(U.staffA, () => fails(`update public.content_items set status = 'approved', approval_id = '${a}' where id = '${other}'`))).toMatch(/only through submit_content/);
    expect((await get(other)).status).toBe("draft");
    expect((await get(p)).approval_id).toBe(a);
  });

  it("the wording of pending, approved and published posts is locked against direct edits, for staff and for owners alike", async () => {
    const pending = (await submitted()).p;
    const approved = await (async () => { const s = await submitted(); await as(U.approverA, () => db.query(`select public.decide_approval('${s.a}', 'approve')`)); return s.p; })();
    const published = await post({ status: "published" });
    for (const [label, id] of [["pending", pending], ["approved", approved], ["published", published]] as const) {
      for (const user of [U.staffA, U.ownerA]) {
        for (const set of ["caption = 'Real gold, only ₹1'", "title = 'New title'", "topic = 'x'", "hashtags = array['#x']", "creative_brief = 'x'", "image_direction = 'x'", "platform = 'Facebook'"]) {
          expect(await as(user, () => fails(`update public.content_items set ${set} where id = '${id}'`)), `${label} ${set}`).toMatch(/locked while it is pending approval/);
        }
      }
    }
    // the planned date is not wording, so the calendar can still be rearranged
    await as(U.staffA, () => db.query(`update public.content_items set scheduled_for = '2026-12-01' where id = '${approved}'`));
    expect(String((await get(approved)).scheduled_for)).toContain("2026");
  });

  it("drafts and rejected posts stay editable; rows cannot be inserted already approved or already linked", async () => {
    const draft = await post();
    await as(U.staffA, () => db.query(`update public.content_items set caption = 'New words' where id = '${draft}'`));
    expect((await get(draft)).caption).toBe("New words");
    const rej = await post({ status: "rejected" });
    await as(U.staffA, () => db.query(`update public.content_items set caption = 'Reworded' where id = '${rej}'`));
    expect((await get(rej)).caption).toBe("Reworded");
    for (const extra of ["'approved'", "'pending_approval'", "'published'", "'rejected'"]) {
      expect(await as(U.staffA, () => fails(`insert into public.content_items (org_id, platform, title, status) values ('${ORG_A}', 'Instagram', 'x', ${extra})`)), extra).toMatch(/row-level security/);
    }
    await as(U.staffA, () => db.query(`insert into public.content_items (org_id, platform, title) values ('${ORG_A}', 'Instagram', 'plain')`));
    await as(U.staffA, () => db.query(`insert into public.content_items (org_id, platform, title, status) values ('${ORG_A}', 'Instagram', 'plain 2', 'draft')`));
  });

  it("identity columns cannot be changed by a signed-in user", async () => {
    const p = await post();
    expect(await as(U.staffA, () => fails(`update public.content_items set id = '${uid(9)}' where id = '${p}'`))).toMatch(/identity columns/);
    expect(await as(U.staffA, () => fails(`update public.content_items set org_id = '${ORG_B}' where id = '${p}'`))).toMatch(/row-level security|identity columns/);
  });

  it("viewers and other organisations cannot edit or delete in any state", async () => {
    const p = await post();
    await as(U.viewerA, () => db.query(`update public.content_items set caption = 'hacked' where id = '${p}'`));
    await as(U.staffB, () => db.query(`update public.content_items set caption = 'hacked' where id = '${p}'`));
    expect((await get(p)).caption).toBe("A calm look for spring");
    await as(U.staffA, () => db.query(`delete from public.content_items where id = '${p}'`)); // delete stays owner/admin only
    expect(await get(p)).toBeTruthy();
  });
});

describe("S2: submit_content", () => {
  it("creates a pending approval with a database-built preview and metadata, links it, and logs the activity, in one step", async () => {
    const p = await post({ hashtags: ["#cheri", "#spring"], brief: null, image: "Flat lay" });
    const before = await counts();
    const a = (await as(U.staffA, () => rows(`select public.submit_content('${p}') as id`)))[0].id as string;
    const post1 = await get(p);
    expect(post1.status).toBe("pending_approval");
    expect(post1.approval_id).toBe(a);
    const ap = await approvalOf(a);
    expect(ap).toMatchObject({ status: "pending", type: "Content", generated_by: "content", org_id: ORG_A, title: "Spring post · Instagram post" });
    expect(ap.meta).toEqual({ kind: "content_draft", subject: "Spring post", isSample: false, allowedClaims: [], postId: p });
    expect(ap.preview).toBe(renderPostForApproval({ platform: "Instagram", caption: "A calm look for spring", hashtags: ["#cheri", "#spring"], creativeBrief: "", imageDirection: "Flat lay" }));
    const c = await counts();
    expect(c).toEqual({ approvals: before.approvals + 1, audit: before.audit, activity: before.activity + 1 });
    expect((await rows(`select actor_id, ref_type, ref_id from public.agent_activity where ref_id = '${p}'`))).toEqual([{ actor_id: U.staffA, ref_type: "content_item", ref_id: p }]);
  });

  it("the database-built preview equals the application's preview for empty and full posts", async () => {
    for (const o of [{ hashtags: [], brief: null, image: null }, { hashtags: ["#a", "#b"], brief: "Brief", image: "Image" }]) {
      const p = await post(o);
      const a = (await as(U.ownerA, () => rows(`select public.submit_content('${p}') as id`)))[0].id as string;
      expect((await approvalOf(a)).preview).toBe(renderPostForApproval({ platform: "Instagram", caption: "A calm look for spring", hashtags: o.hashtags, creativeBrief: o.brief ?? "", imageDirection: o.image ?? "" }));
    }
  });

  it("refuses prohibited wording, a missing caption, a second submission and anything that is not a draft; nothing is written", async () => {
    const bad = await post({ caption: "Real gold, ONLY ₹499" });
    const blank = await post({ caption: "   " });
    const none = await post({ caption: null });
    const { p: done } = await submitted();
    const rej = await post({ status: "rejected" });
    const before = await counts();
    expect(await as(U.staffA, () => fails(`select public.submit_content('${bad}')`))).toMatch(/prohibited claims/);
    expect(await as(U.staffA, () => fails(`select public.submit_content('${blank}')`))).toMatch(/caption is required/);
    expect(await as(U.staffA, () => fails(`select public.submit_content('${none}')`))).toMatch(/caption is required/);
    expect(await as(U.staffA, () => fails(`select public.submit_content('${done}')`))).toMatch(/only drafts/);
    expect(await as(U.staffA, () => fails(`select public.submit_content('${rej}')`))).toMatch(/only drafts/);
    expect(await counts()).toEqual(before);
    expect((await get(bad)).status).toBe("draft");
    expect((await get(bad)).approval_id).toBeNull();
  });

  it("a failure part-way leaves no half-submitted state (an approval that cannot be created rolls the status back too)", async () => {
    const p = await post({ title: "x".repeat(200) }); // title + platform text is cut to 200, so use a check that really fails instead:
    await db.exec(`alter table public.approvals add constraint test_block check (title <> 'FAIL · Instagram post')`);
    const q2 = await post({ title: "FAIL" });
    const before = await counts();
    expect(await as(U.staffA, () => fails(`select public.submit_content('${q2}')`))).toMatch(/test_block|check constraint/);
    expect(await counts()).toEqual(before);
    expect((await get(q2)).status).toBe("draft");
    await db.exec("alter table public.approvals drop constraint test_block");
    expect((await as(U.staffA, () => rows(`select public.submit_content('${p}') as id`)))[0].id).toBeTruthy(); // a long title still works
  });

  it("viewers, visitors, other organisations and strangers cannot submit", async () => {
    const p = await post();
    expect(await as(U.viewerA, () => fails(`select public.submit_content('${p}')`))).toMatch(/not authorized/);
    expect(await as(U.staffB, () => fails(`select public.submit_content('${p}')`))).toMatch(/not found/);
    expect(await as(U.loner, () => fails(`select public.submit_content('${p}')`))).toMatch(/not found/);
    expect(await as(null, () => fails(`select public.submit_content('${p}')`))).toMatch(/permission denied/);
    expect(await fails(`select public.submit_content('${uid(8)}')`)).toMatch(/not found/);
    expect((await get(p)).status).toBe("draft");
  });

  it("writers cannot forge the metadata that links an approval to a post", async () => {
    const p = await post();
    for (const meta of [{ postId: p }, { kind: "content_draft" }, { postId: uid(7), allowedClaims: ["x"] }]) {
      expect(await as(U.staffA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('${ORG_A}', 'x', 'Content', 'content', 'p', ${q(JSON.stringify(meta))})`))).toMatch(/set only by the approval workflow/);
    }
    await as(U.staffA, () => db.query(`insert into public.approvals (org_id, title, type, generated_by, preview, meta) values ('${ORG_A}', 'ok', 'Other', 'crm', 'p', '{"note":"fine"}')`));
  });
});

describe("S2: decide_approval keeps post and approval together", () => {
  it("approve and reject move the post in the same transaction", async () => {
    const x = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${x.a}', 'approve')`));
    expect((await get(x.p)).status).toBe("approved");
    const y = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${y.a}', 'reject', 'no')`));
    expect((await get(y.p)).status).toBe("rejected");
  });

  it("an approval whose metadata names a different post is refused (forged or mismatched metadata), with no change", async () => {
    const p = await post({ status: "pending_approval" });
    const other = await post();
    const a = uid(2);
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview, meta) values ('${a}', '${ORG_A}', 'T', 'Content', 'content', 'Caption: calm', ${q(JSON.stringify({ kind: "content_draft", postId: other }))})`);
    await db.exec(`update public.content_items set approval_id = '${a}' where id = '${p}'`);
    const before = await counts();
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/does not match its post/);
    expect(await counts()).toEqual(before);
    expect((await approvalOf(a)).status).toBe("pending");
    expect((await get(p)).status).toBe("pending_approval");
    // F3: rejecting is still possible, so the item can be cleared from the queue; only the approval changes, never the other post
    expect((await as(U.approverA, () => rows(`select status from public.decide_approval('${a}', 'reject', 'bad link')`)))[0].status).toBe("rejected");
    expect((await get(p)).status).toBe("pending_approval");
    expect((await get(other)).status).toBe("draft");
  });

  it("an approval whose post is not waiting for approval cannot be approved, but it can be rejected to clear the queue (F3)", async () => {
    const p = await post({ status: "draft" });
    const a = uid(2);
    await db.exec(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${a}', '${ORG_A}', 'T', 'Content', 'content', 'Caption: calm')`);
    await db.exec(`update public.content_items set approval_id = '${a}' where id = '${p}'`);
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/not waiting for approval/);
    expect((await approvalOf(a)).status).toBe("pending");
    const before = await counts();
    expect((await as(U.approverA, () => rows(`select status from public.decide_approval('${a}', 'reject', 'stale')`)))[0].status).toBe("rejected");
    expect((await get(p)).status).toBe("draft"); // the post is untouched
    expect((await counts()).audit).toBe(before.audit + 1);
    expect(await as(U.staffA, () => fails(`select public.decide_approval('${a}', 'reject')`))).toMatch(/not authorized/); // roles unchanged
  });

  it("a failed decision (prohibited claims) changes neither the approval, the post, nor the audit log", async () => {
    const { p, a } = await submitted();
    await db.exec(`update public.approvals set preview = 'Caption: guaranteed' where id = '${a}'`); // administrator repair, not an API path
    const before = await counts();
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/prohibited/);
    expect(await counts()).toEqual(before);
    expect((await get(p)).status).toBe("pending_approval");
  });

  it("another organisation's approval and post are invisible and untouchable", async () => {
    const { p, a } = await submitted();
    expect(await as(U.ownerB, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/not found/);
    expect(await as(U.ownerB, () => fails(`select public.reopen_content('${p}')`))).toMatch(/not found/);
    expect(await as(U.ownerB, () => rows(`select * from public.content_items where id = '${p}'`))).toEqual([]);
  });
});

describe("S2: reopen_content and the edit-and-resubmit workflow", () => {
  it("a rejected post is reopened by staff, edited, and resubmitted as a NEW approval; the old approval stays as history", async () => {
    const { p, a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'reject', 'reword')`));
    const before = await counts();
    await as(U.staffA, () => db.query(`select public.reopen_content('${p}')`));
    const reopened = await get(p);
    expect(reopened.status).toBe("draft");
    expect(reopened.approval_id).toBeNull();
    expect((await approvalOf(a)).status).toBe("rejected");
    expect((await counts()).activity).toBe(before.activity + 1);
    await as(U.staffA, () => db.query(`update public.content_items set caption = 'A softer caption' where id = '${p}'`));
    const a2 = (await as(U.staffA, () => rows(`select public.submit_content('${p}') as id`)))[0].id as string;
    expect(a2).not.toBe(a);
    expect((await approvalOf(a2)).preview).toContain("A softer caption");
    expect((await get(p)).status).toBe("pending_approval");
    expect((await rows(`select status from public.approvals where id = '${a}'`))[0].status).toBe("rejected");
  });

  it("an approved post can be withdrawn only by owner, admin or approver, and then needs a new approval", async () => {
    const { p, a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'approve')`));
    expect(await as(U.staffA, () => fails(`select public.reopen_content('${p}')`))).toMatch(/not authorized/);
    expect(await as(U.viewerA, () => fails(`select public.reopen_content('${p}')`))).toMatch(/not authorized/);
    expect((await get(p)).status).toBe("approved");
    await as(U.adminA, () => db.query(`select public.reopen_content('${p}')`));
    expect((await get(p)).status).toBe("draft");
    expect((await approvalOf(a)).status).toBe("approved"); // the decision itself is history
  });

  it("a post waiting for a decision cannot be reopened; a pending post with no pending approval behind it can", async () => {
    const { p } = await submitted();
    expect(await as(U.staffA, () => fails(`select public.reopen_content('${p}')`))).toMatch(/waiting for a decision/);
    const orphan = await post({ status: "pending_approval" });
    await as(U.staffA, () => db.query(`select public.reopen_content('${orphan}')`));
    expect((await get(orphan)).status).toBe("draft");
  });

  it("reopening a draft is a harmless no-op; visitors and strangers cannot reopen anything", async () => {
    const p = await post();
    const before = await counts();
    await as(U.staffA, () => db.query(`select public.reopen_content('${p}')`));
    expect(await counts()).toEqual(before);
    expect(await as(null, () => fails(`select public.reopen_content('${p}')`))).toMatch(/permission denied/);
    expect(await as(U.loner, () => fails(`select public.reopen_content('${p}')`))).toMatch(/not found/);
  });

  it("a reopened post that gets prohibited wording cannot be resubmitted", async () => {
    const { p, a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'reject')`));
    await as(U.staffA, () => db.query(`select public.reopen_content('${p}')`));
    await as(U.staffA, () => db.query(`update public.content_items set caption = 'Waterproof, guaranteed' where id = '${p}'`));
    expect(await as(U.staffA, () => fails(`select public.submit_content('${p}')`))).toMatch(/prohibited claims/);
    expect((await get(p)).status).toBe("draft");
  });
});

/* ------------------------------------------------------------------ review fixes */
describe("F1: look-alike spellings cannot slip past the claim rules", () => {
  // each of these was accepted before normalisation (confirmed in the independent review)
  // Built from code points, so no invisible or look-alike character sits in this file.
  const cp = (...hex: string[]) => hex.map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
  const fullwidth = (s: string) => Array.from(s).map((c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0)).join("");
  const EVASIONS: [string, string][] = [
    ["no-break space after the rupee sign", "price is ₹" + cp("a0") + "500"],
    ["zero-width space inside a word", "waterpro" + cp("200b") + "of"],
    ["zero-width joiner", "guar" + cp("200d") + "antee"],
    ["soft hyphen", "water" + cp("ad") + "proof"],
    ["non-breaking hyphen", "water" + cp("2011") + "proof"],
    ["en dash", "anti" + cp("2013") + "tarnish"],
    ["minus sign as a dash", "nickel" + cp("2212") + "free"],
    ["fullwidth percent sign", "50" + cp("ff05") + " off"],
    ["fullwidth letters", fullwidth("waterproof")],
    ["Cyrillic a in guarantee", "gu" + cp("430") + "rantee"],
    ["Cyrillic o and e in hypoallergenic", "hyp" + cp("43e") + "all" + cp("435") + "rgenic"],
    ["Greek omicron in waterproof", "waterpr" + cp("3bf", "3bf") + "f"],
    ["combining accent", "gua" + cp("301") + "rantee"],
    ["line break inside a phrase", "only" + cp("a") + "5 left"],
    ["tabs instead of a space", "in" + cp("9", "9") + "stock"],
    ["ideographic space", "free" + cp("3000") + "shipping"],
    ["line separator", "sold" + cp("2028") + "out"],
    ["en space in a price", "Rs." + cp("2002") + "9"],
    ["word joiner and BOM", "life" + cp("2060") + "time " + cp("feff") + "wear"],
  ];

  it("the database and the application both catch every look-alike, and agree on the result", async () => {
    for (const [label, text] of EVASIONS) {
      const js = findProhibitedClaims(text, []).map((v) => `${v.label}: "${v.match}"`.toLowerCase()).sort();
      const sql = ((await rows(`select private.find_prohibited_claims(${q(text)}) as h`))[0].h as string[]).map((s) => s.toLowerCase()).sort();
      expect(js.length, `js ${label}`).toBeGreaterThan(0);
      expect(sql, label).toEqual(js);
    }
  });

  it("the normalised text is identical in the database and the application, including for ordinary non-Latin copy", async () => {
    const samples = [...EVASIONS.map((e) => e[1]), "A calm look for spring", "सुंदर गहने — हाथ से बने", "Café au lait, naïve façade", "இனிய காலை", "日本語のテキスト　です", "emoji 💍✨ and #cheri"];
    for (const s of samples) expect((await rows(`select private.normalize_claim_text(${q(s)}) as t`))[0].t, JSON.stringify(s)).toBe(normalizeClaimText(s));
  });

  it("ordinary copy in other scripts is left alone (no false alarms from the normaliser)", async () => {
    for (const s of ["सुंदर गहने — हाथ से बने", "Café au lait, naïve façade", "இனிய காலை", "日本語のテキスト", "A calm look for spring"]) {
      expect(findProhibitedClaims(s, []), s).toEqual([]);
      expect((await rows(`select private.find_prohibited_claims(${q(s)}) as h`))[0].h, s).toEqual([]);
    }
  });

  it("the normalisation steps in the migration are the ones in claims.ts, so the copies cannot drift", () => {
    expect([...CLAIM_NORMALISATION.confusableFrom]).toHaveLength([...CLAIM_NORMALISATION.confusableTo].length);
    expect(HARDENING).toContain(`translate(t, '${CLAIM_NORMALISATION.confusableFrom}', '${CLAIM_NORMALISATION.confusableTo}')`);
    expect(HARDENING).toContain(`'${CLAIM_NORMALISATION.accents}'`);
    expect(HARDENING).toContain(`'${CLAIM_NORMALISATION.invisible}'`);
    expect(HARDENING).toContain(`'${CLAIM_NORMALISATION.dashes}'`);
    expect(HARDENING).toContain(`'${CLAIM_NORMALISATION.space}'`);
  });

  it("a direct call cannot get a look-alike through submit_content or decide_approval", async () => {
    for (const [label, text] of EVASIONS) {
      const p = await post({ caption: `A calm look, ${text}` });
      expect(await as(U.staffA, () => fails(`select public.submit_content('${p}')`)), label).toMatch(/prohibited claims/);
      const a = uid(5);
      await as(U.staffA, () => db.query(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${a}', '${ORG_A}', 'T', 'Content', 'content', ${q(`Caption: ${text}`)})`));
      expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`)), label).toMatch(/prohibited claims/);
    }
  });

  it("the normaliser is not callable by signed-in users or visitors", async () => {
    expect(await as(U.ownerA, () => fails("select private.normalize_claim_text('x')"))).toMatch(/permission denied/);
    expect(await as(null, () => fails("select private.normalize_claim_text('x')"))).toMatch(/permission denied/);
  });
});

describe("F4: the approved text always equals the post", () => {
  it("a content approval that belongs to a post cannot be edited, by anyone who can decide; nothing changes", async () => {
    const { p, a } = await submitted();
    const before = await counts();
    for (const u of [U.approverA, U.adminA, U.ownerA]) {
      expect(await as(u, () => fails(`select public.decide_approval('${a}', 'edit', null, 'Other title', 'Totally different caption')`))).toMatch(/cannot be edited/);
    }
    expect(await counts()).toEqual(before);
    const ap = await approvalOf(a);
    expect(ap.preview).not.toContain("Totally different");
    expect(ap.title).toBe("Spring post · Instagram post");
    expect((await get(p)).status).toBe("pending_approval");
  });

  it("the approved text is exactly the post as submitted, because the post cannot change while it waits", async () => {
    const { p, a } = await submitted();
    expect(await as(U.staffA, () => fails(`update public.content_items set caption = 'Something else' where id = '${p}'`))).toMatch(/locked/);
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'approve')`));
    const post1 = await get(p);
    const ap = await approvalOf(a);
    expect(ap.preview).toBe(renderPostForApproval({ platform: "Instagram", caption: String(post1.caption), hashtags: post1.hashtags as string[], creativeBrief: String(post1.creative_brief ?? ""), imageDirection: String(post1.image_direction ?? "") }));
  });

  it("an edit is still possible for an approval that does not belong to a post, and a rejected post is changed through reopen and resubmit", async () => {
    const a = uid(6);
    await as(U.staffA, () => db.query(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${a}', '${ORG_A}', 'Reply', 'B2C reply', 'b2c', 'Hello')`));
    expect((await as(U.approverA, () => rows(`select preview from public.decide_approval('${a}', 'edit', null, null, 'Hello there')`)))[0].preview).toBe("Hello there");
    const { p, a: a1 } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a1}', 'reject', 'reword please')`));
    await as(U.staffA, () => db.query(`select public.reopen_content('${p}')`));
    await as(U.staffA, () => db.query(`update public.content_items set caption = 'A softer caption' where id = '${p}'`));
    const a2 = (await as(U.staffA, () => rows(`select public.submit_content('${p}') as id`)))[0].id as string;
    expect((await approvalOf(a2)).preview).toContain("A softer caption");
  });
});

describe("F5: submit and reopen history cannot be forged", () => {
  it("a writer cannot insert activity that points at a content item or an approval", async () => {
    const p = await post();
    for (const refType of ["content_item", "approval"]) {
      expect(await as(U.staffA, () => fails(`insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id) values ('${ORG_A}', 'content', 'Reopened "Spring post" (Instagram) for editing', '${refType}', '${p}', '${U.staffA}')`)), refType).toMatch(/row-level security/);
    }
    expect(await as(U.ownerA, () => fails(`insert into public.agent_activity (org_id, agent, action, ref_type, ref_id, actor_id) values ('${ORG_A}', 'content', 'x', 'content_item', '${p}', '${U.ownerA}')`))).toMatch(/row-level security/);
  });

  it("ordinary activity still works, with the caller as actor, and the actor cannot be someone else", async () => {
    await as(U.staffA, () => db.query(`insert into public.agent_activity (org_id, agent, action, actor_id) values ('${ORG_A}', 'crm', 'Added customer: Asha', '${U.staffA}')`));
    await as(U.staffA, () => db.query(`insert into public.agent_activity (org_id, agent, action, ref_type, actor_id) values ('${ORG_A}', 'crm', 'Moved a deal', 'deal', '${U.staffA}')`));
    expect(await as(U.staffA, () => fails(`insert into public.agent_activity (org_id, agent, action, actor_id) values ('${ORG_A}', 'crm', 'x', '${U.ownerA}')`))).toMatch(/row-level security/);
    expect(await as(U.viewerA, () => fails(`insert into public.agent_activity (org_id, agent, action, actor_id) values ('${ORG_A}', 'crm', 'x', '${U.viewerA}')`))).toMatch(/row-level security/);
  });

  it("the functions still write their own history, so the only rows that point at a post are real ones", async () => {
    const { p, a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'approve')`));
    await as(U.adminA, () => db.query(`select public.reopen_content('${p}')`));
    const log = await rows(`select action, actor_id, ref_type from public.agent_activity where ref_id = '${p}' order by id`);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actor_id: U.staffA, ref_type: "content_item" });
    expect(String(log[0].action)).toMatch(/^Sent "Spring post"/);
    expect(log[1]).toMatchObject({ actor_id: U.adminA, ref_type: "content_item" });
    expect(String(log[1].action)).toMatch(/^Reopened "Spring post".*it had been approved and needs approval again/);
  });

  it("reopening a rejected post is recorded without the 'had been approved' wording, and history stays append-only", async () => {
    const { p, a } = await submitted();
    await as(U.approverA, () => db.query(`select public.decide_approval('${a}', 'reject')`));
    await as(U.staffA, () => db.query(`select public.reopen_content('${p}')`));
    const last = (await rows(`select action from public.agent_activity where ref_id = '${p}' order by id desc limit 1`))[0];
    expect(String(last.action)).toBe('Reopened "Spring post" (Instagram) for editing');
    expect(await fails("delete from public.agent_activity")).toMatch(/append-only/);
  });
});

describe("F6: titles and topics are scanned too", () => {
  it("submit_content refuses prohibited wording in the title or the topic, and writes nothing", async () => {
    const cases = [{ title: "100% guaranteed waterproof" }, { title: "Spring post", topic: "Lowest price of the year" }, { title: "Only ₹499 today" }];
    for (const c of cases) {
      const p = await post({ title: c.title });
      if (c.topic) await db.exec(`update public.content_items set topic = ${q(c.topic)} where id = '${p}'`);
      const before = await counts();
      expect(await as(U.staffA, () => fails(`select public.submit_content('${p}')`)), JSON.stringify(c)).toMatch(/prohibited claims/);
      expect(await counts()).toEqual(before);
      expect((await get(p)).status).toBe("draft");
    }
  });

  it("decide_approval scans the post's title and topic and the approval's title", async () => {
    const { p, a } = await submitted();
    await db.exec(`update public.content_items set topic = 'cheapest in town' where id = '${p}'`); // administrator repair, not an API path
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${a}', 'approve')`))).toMatch(/prohibited claims/);
    const b = uid(9);
    await as(U.staffA, () => db.query(`insert into public.approvals (id, org_id, title, type, generated_by, preview) values ('${b}', '${ORG_A}', 'Real gold sale', 'Content', 'content', 'Caption: calm')`));
    expect(await as(U.approverA, () => fails(`select public.decide_approval('${b}', 'approve')`))).toMatch(/prohibited claims/);
    expect((await approvalOf(b)).status).toBe("pending");
  });

  it("a clean title and topic are unaffected", async () => {
    const p = await post({ title: "Spring collection preview" });
    await db.exec(`update public.content_items set topic = 'seasonal mood' where id = '${p}'`);
    expect((await as(U.staffA, () => rows(`select public.submit_content('${p}') as id`)))[0].id).toBeTruthy();
  });
});

describe("F12: a post that is too long to approve gets a plain refusal", () => {
  const preview = (tag: string) => renderPostForApproval({ platform: "Instagram", caption: "A calm look for spring", hashtags: [tag], creativeBrief: "Soft light", imageDirection: "Flat lay" });
  const tagForLength = (n: number) => "#" + "a".repeat(n - preview("#").length); // a tag that makes the whole preview n characters long

  it("exactly 6000 characters is accepted and 6001 is refused with a clear message; nothing is written", async () => {
    const ok = tagForLength(6000);
    expect(preview(ok).length).toBe(6000);
    const good = await post({ hashtags: [ok] });
    expect((await as(U.staffA, () => rows(`select public.submit_content('${good}') as id`)))[0].id).toBeTruthy();
    const tooLong = tagForLength(6001);
    expect(preview(tooLong).length).toBe(6001);
    const bad = await post({ hashtags: [tooLong] });
    const before = await counts();
    expect(await as(U.staffA, () => fails(`select public.submit_content('${bad}')`))).toMatch(/too long to send for approval/);
    expect(await counts()).toEqual(before);
    expect((await get(bad)).status).toBe("draft");
  });

  it("many hashtags are refused the same way, and the message is not the claims message", async () => {
    const p = await post({ hashtags: Array.from({ length: 200 }, (_, i) => `#tag${i}${"x".repeat(40)}`) });
    const msg = await as(U.staffA, () => fails(`select public.submit_content('${p}')`));
    expect(msg).toMatch(/too long to send for approval/);
    expect(msg).not.toMatch(/prohibited claims/);
  });
});

/* ------------------------------------------------------------------ regression */
describe("F2, F9, F10, F11, F15: the remaining review items that the database can enforce", () => {
  it("F9: every column except the planned date is locked on pending, approved and published posts, including columns added later", async () => {
    const { p } = await submitted();
    await db.exec("alter table public.content_items add column internal_note text");
    try {
      expect(await as(U.staffA, () => fails(`update public.content_items set internal_note = 'x' where id = '${p}'`))).toMatch(/locked while it is pending approval/);
      await as(U.staffA, () => db.query(`update public.content_items set scheduled_for = '2026-12-02' where id = '${p}'`));
      expect((await rows(`select scheduled_for::text d from public.content_items where id = '${p}'`))[0].d).toBe("2026-12-02");
      const draft = await post();
      await as(U.staffA, () => db.query(`update public.content_items set internal_note = 'ok' where id = '${draft}'`));
    } finally { await db.exec("alter table public.content_items drop column internal_note"); }
  });

  it("F10: an approval can belong to only one post", async () => {
    const { a } = await submitted();
    const other = await post();
    expect(await fails(`update public.content_items set status = 'pending_approval', approval_id = '${a}' where id = '${other}'`)).toMatch(/content_items_approval_id_key|duplicate key/);
    await post(); await post(); // many posts without an approval are fine
  });

  it("F11: deleting a post is recorded with the person who did it, and only owner or admin can delete", async () => {
    const p = await post({ title: "To delete", status: "approved" });
    await as(U.staffA, () => db.query(`delete from public.content_items where id = '${p}'`));
    expect(await get(p)).toBeTruthy();
    await as(U.adminA, () => db.query(`delete from public.content_items where id = '${p}'`));
    expect(await get(p)).toBeUndefined();
    const log = await rows(`select action, actor_id, agent from public.agent_activity where ref_type = 'content_item' and ref_id = '${p}' order by id desc limit 1`);
    expect(log[0]).toMatchObject({ actor_id: U.adminA, agent: "content" });
    expect(String(log[0].action)).toContain('Deleted "To delete"');
    expect(String(log[0].action)).toContain("was approved");
  });

  it("F11: deleting a whole organisation still works (the delete log is skipped, no broken reference)", async () => {
    const org = "dddddddd-0000-0000-0000-000000000009";
    await db.exec(`insert into public.organizations (id, name) values ('${org}', 'Temp'); insert into public.content_items (org_id, platform, title) values ('${org}', 'Instagram', 'gone')`);
    await db.exec(`delete from public.organizations where id = '${org}'`);
    expect((await rows(`select count(*)::int n from public.content_items where org_id = '${org}'`))[0].n).toBe(0);
  });

  it("F11: the delete-log function is not callable by signed-in users", async () => {
    expect(await as(U.ownerA, () => fails("select private.content_items_log_delete()"))).toMatch(/permission denied|trigger/);
  });

  it("F15: a new post always records the signed-in caller as its creator, whatever the request says", async () => {
    const forged = uid(7);
    await as(U.staffA, () => db.query(`insert into public.content_items (id, org_id, platform, title, created_by) values ('${forged}', '${ORG_A}', 'Instagram', 'x', '${U.ownerA}')`));
    expect((await get(forged)).created_by).toBe(U.staffA);
    const none = uid(7);
    await as(U.staffA, () => db.query(`insert into public.content_items (id, org_id, platform, title, created_by) values ('${none}', '${ORG_A}', 'Instagram', 'y', null)`));
    expect((await get(none)).created_by).toBe(U.staffA);
  });
});

describe("foundation guarantees still hold with the hardening migration applied", () => {
  it("RLS is on for every public table and visitors get no access", async () => {
    expect(await rows("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")).toEqual([]);
    for (const t of ["customers", "approvals", "content_items", "audit_log", "agent_activity"]) {
      expect(await as(null, () => fails(`select * from public.${t}`)), t).toMatch(/permission denied/);
    }
  });
  it("the three controlled functions are not executable by visitors, and run with a fixed search_path", async () => {
    for (const f of ["submit_content(uuid)", "reopen_content(uuid)", "decide_approval(uuid, text, text, text, text)"]) {
      const r = await rows(`select has_function_privilege('anon', 'public.${f}', 'execute') as anon, has_function_privilege('authenticated', 'public.${f}', 'execute') as auth, p.prosecdef as definer, p.proconfig as cfg from pg_proc p where p.oid = 'public.${f}'::regprocedure`);
      expect(r[0], f).toMatchObject({ anon: false, auth: true, definer: true });
      expect(String(r[0].cfg), f).toContain("search_path=");
    }
  });
  it("approvals still cannot be updated or deleted directly, and a new one must start pending", async () => {
    const { a } = await submitted();
    expect(await as(U.ownerA, () => fails(`update public.approvals set status = 'approved' where id = '${a}'`))).toMatch(/permission denied/);
    expect(await as(U.ownerA, () => fails(`delete from public.approvals where id = '${a}'`))).toMatch(/permission denied/);
    expect(await as(U.staffA, () => fails(`insert into public.approvals (org_id, title, type, generated_by, preview, status) values ('${ORG_A}', 't', 'Content', 'content', 'p', 'approved')`))).toMatch(/row-level security/);
  });
  it("organisation isolation: members see only their organisation's posts and approvals", async () => {
    await post({ org: ORG_B, title: "B only" });
    expect((await as(U.ownerA, () => rows("select title from public.content_items"))).map((r) => r.title)).not.toContain("B only");
    expect((await as(U.ownerB, () => rows("select title from public.content_items"))).map((r) => r.title)).toEqual(["B only"]);
    expect(await as(U.loner, () => rows("select * from public.content_items"))).toEqual([]);
  });
  it("the hardening migration can be applied twice without error (safe to re-run after a rollback)", async () => {
    const fresh = new PGlite();
    try {
      await fresh.exec(stub);
      await fresh.exec(readFileSync("supabase/migrations/20261101000000_foundation.sql", "utf8"));
      await fresh.exec(HARDENING);
      await fresh.exec(HARDENING);
      expect((await fresh.query("select count(*)::int n from pg_trigger where tgname in ('content_items_guard','approvals_meta_guard','content_items_set_creator','content_items_log_delete')")).rows[0]).toEqual({ n: 4 });
    } finally { await fresh.close(); }
  });
  it("the hardening migration is transaction-wrapped and does not touch the foundation migration", () => {
    expect(HARDENING).toMatch(/^begin;/m);
    expect(HARDENING.trimEnd()).toMatch(/commit;$/);
    expect(HARDENING).not.toMatch(/drop (table|schema)|truncate|delete from/i);
  });
});
