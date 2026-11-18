/** Content Studio (Milestone 2): Brand Brain, prompt/input/output contract, generator fallbacks, and the whole live workflow
 *  product -> generate -> save draft -> edit -> regenerate -> submit -> approve/reject -> activity history.
 *  Every model call goes to a scripted FAKE transport and the database is a recording in-memory fake: nothing touches OpenAI or Supabase. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  t: {} as Record<string, Row[]>, reads: [] as string[], n: 0,
  /** Makes opening this table throw a TypeError (a code fault), or makes an insert into content_items fail like the database refusing it. */
  crash: "", insertError: null as null | { code: string; message: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u1@test.invalid" } }, error: null }) },
    rpc: async (fn: string, a: Record<string, unknown>) => {
      const row = (db.t.approvals ?? []).find((r) => r.id === a.p_id);
      if (fn !== "decide_approval" || !row) return { data: null, error: { code: "P0002", message: "not found" } };
      if (row.status !== "pending") return { data: null, error: { code: "P0001", message: "already decided" } };
      row.status = a.p_action === "approve" ? "approved" : "rejected";
      (db.t.audit_log ??= []).push({ id: ++db.n, org_id: row.org_id, approval_id: row.id, action: a.p_action, actor_id: "u1", note: a.p_note ?? null, at: new Date().toISOString() });
      return { data: { ...row }, error: null };
    },
    from: (table: string) => {
      db.reads.push(table);
      if (db.crash === table) throw new TypeError("boom: simulated code fault");
      let op = "select";
      let payload: Row = {};
      const eq: [string, unknown][] = [];
      const inn: [string, unknown[]][] = [];
      const like: [string, string][] = [];
      const gte: [string, string][] = [];
      let single = false;
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (p: Row) => { op = "insert"; payload = p; return q; },
        update: (p: Row) => { op = "update"; payload = p; return q; },
        delete: () => { op = "delete"; return q; },
        eq: (k: string, v: unknown) => { eq.push([k, v]); return q; },
        in: (k: string, v: unknown[]) => { inn.push([k, v]); return q; },
        like: (k: string, v: string) => { like.push([k, v]); return q; },
        gte: (k: string, v: string) => { gte.push([k, v]); return q; },
        not: () => q, order: () => q, limit: () => q, range: () => q,
        single: () => { single = true; return q; }, maybeSingle: () => { single = true; return q; },
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          const rows = (db.t[table] ??= []);
          const match = (r: Row) => eq.every(([k, v]) => r[k] === v) && inn.every(([k, v]) => v.includes(r[k])) && like.every(([k, v]) => String(r[k]).startsWith(v.replace(/%$/, "")))
            && gte.every(([k, v]) => String(r[k]) >= v);
          let out: Row[];
          if (op === "insert" && table === "content_items" && db.insertError) return resolve({ data: null, error: db.insertError });
          if (op === "insert") {
            const made: Row = { id: table === "agent_activity" || table === "audit_log" ? ++db.n : crypto.randomUUID(), created_at: new Date().toISOString(), ...(table === "content_items" ? { approval_id: null } : {}), ...payload };
            rows.push(made);
            out = [made];
          } else if (op === "update") {
            out = rows.filter(match);
            for (const r of out) Object.assign(r, payload);
          } else out = rows.filter(match);
          resolve({ data: single ? (out[0] ?? null) : out.map((r) => ({ ...r })), error: null });
        },
      };
      return q;
    },
  }),
}));

import { decideApproval, getActivities } from "@/services";
import { __setAiTransportForTests } from "@/services/content-ai";
import { POST as generateRoute } from "@/app/api/content-studio/generate/route";
import { POST as socialAction } from "@/app/api/social/posts/[id]/[action]/route";
import type { AiConfig } from "@/lib/ai/config";
import { CallRateLimiter } from "@/lib/ai/limits";
import { BRAND_FACTS, BRAND_NEVER, BRAND_SIGNATURE, brandForPrompt } from "@/lib/content-studio/brand-brain";
import { assemblePost, runStudio, templateCopy, type StudioDeps, type StudioRequest } from "@/lib/content-studio/generate";
import { STUDIO_KINDS, KIND_META } from "@/lib/content-studio/kinds";
import { buildStudioInput, cleanTheme, parseStudioOutput, studioInstructions } from "@/lib/content-studio/prompt";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { MemoryLedger, fakeTransport, okBody } from "./helpers/fake-openai";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P_OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const P_ARCHIVED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const POST_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const IMAGE = "https://img.example.com/p1.jpg";
const stamp = new Date().toISOString();

const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true, model: "test-model", maxOutputTokens: 1000, timeoutMs: 5000, monthlyBudgetUsd: 20, dailyCallsPerOrg: 100, perUserPerMinute: 5, priceInPerMTok: 2, priceOutPerMTok: 8, ...over,
});
const REQ: StudioRequest = {
  product: { id: P1, name: "Pearl hoop earrings", category: "Earrings", description: "Small pearl hoops. Comes in a gift box.", imageUrl: IMAGE },
  kind: "facebook_post", audience: "everyday",
};
const GOOD = { headline: "", body: "Small pearl hoops, made for everyday wear.\n\nSimple, light and easy to style." };
const deps = (t: ReturnType<typeof fakeTransport> | null, over: Partial<StudioDeps> = {}, ledger = new MemoryLedger()): StudioDeps & { ledger: MemoryLedger } =>
  ({ config: cfg(), transport: t ? t.transport : null, ledger, limiter: new CallRateLimiter(100), userKey: "u1", ...over }) as StudioDeps & { ledger: MemoryLedger };

describe("Brand Brain", () => {
  it("only confirmed, in-copy facts are given to the model as facts; the assumed voice is style guidance", () => {
    const b = brandForPrompt();
    expect(b.facts).toEqual(BRAND_FACTS.filter((f) => f.inCopy && f.status === "confirmed").map((f) => f.text));
    expect(b.style_guidance).toEqual(BRAND_FACTS.filter((f) => f.status === "assumed").map((f) => f.text));
    expect(b.never).toBe(BRAND_NEVER);
    expect(BRAND_FACTS.filter((f) => f.status === "assumed").every((f) => f.id === "voice")).toBe(true);
  });
  it("invents no claim: no brand fact trips the claim guard, and no price, material or certification wording appears", () => {
    for (const f of BRAND_FACTS) expect(findProhibitedClaims(f.text), f.id).toEqual([]);
    expect(BRAND_FACTS.map((f) => f.text).join(" ")).not.toMatch(/\b(?:925|sterling|plated|waterproof|hypoallergenic|certified|₹|\$)/i);
    expect(findProhibitedClaims(BRAND_SIGNATURE)).toEqual([]);
  });
});

describe("prompt and input", () => {
  it("sends the brand, the product name, category and owner description, and the campaign note: nothing else about the product", () => {
    const { input } = buildStudioInput({ product: REQ.product, kind: "campaign_copy", audience: "gifting", theme: "A calm look" });
    const o = JSON.parse(input);
    expect(Object.keys(o).sort()).toEqual(["audience", "brand", "campaign_note", "content_type", "product"]);
    expect(o.product).toEqual({ name: "Pearl hoop earrings", category: "Earrings", owner_description: "Small pearl hoops. Comes in a gift box." });
    expect(o.campaign_note).toBe("A calm look");
    expect(input).not.toContain("img.example.com");
    expect(input).not.toContain(P1);
  });
  it("redacts personal data hidden in a description and counts it", () => {
    const { input, redactions } = buildStudioInput({ product: { ...REQ.product, description: "Ask Meera on meera@x.com or +91 98765 43210." }, kind: "facebook_post", audience: "everyday" });
    expect(input).not.toMatch(/meera@x\.com|98765/);
    expect(redactions).toBeGreaterThanOrEqual(2);
  });
  it("the campaign note must be plain: personal data, control characters and over-long notes are refused", () => {
    expect(cleanTheme("A calm look")).toEqual({ ok: true, theme: "A calm look" });
    expect(cleanTheme("")).toEqual({ ok: true, theme: "" });
    for (const bad of ["Call 98765 43210 now", "mail me@x.com", "see https://x.com", "a".repeat(201), "bad\u0007", 5]) expect(cleanTheme(bad).ok, String(bad).slice(0, 20)).toBe(false);
  });
  it("the instructions forbid invented specifications, prices, offers, stock and material claims, and name the kind", () => {
    const text = studioInstructions("linkedin_post");
    expect(text).toMatch(/Never invent a product specification/);
    expect(text).toMatch(/price/);
    expect(text).toMatch(/materials, plating, durability/);
    expect(text).toMatch(/LinkedIn post/);
  });
  it("validates the model's JSON per kind: links, hashtags, handles, personal data and wrong lengths are rejected", () => {
    const ok = parseStudioOutput("facebook_post");
    expect(ok(GOOD)).toEqual({ headline: "", body: GOOD.body });
    for (const bad of [{ body: "See https://x.com now, lovely pearls" }, { body: "A lovely pearl hoop #pearls for you" }, { body: "Follow @cheri for pearl hoops please" },
      { body: "Call 98765 43210 about these pearl hoops" }, { body: "short" }, { body: "x".repeat(1201) }, { body: 7 }, null, [], "text"]) expect(ok(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull();
    expect(parseStudioOutput("campaign_copy")({ headline: "", body: GOOD.body })).toBeNull(); // campaign copy needs a headline
    expect(parseStudioOutput("campaign_copy")({ headline: "Everyday pearls", body: GOOD.body })).toEqual({ headline: "Everyday pearls", body: GOOD.body });
  });
});

describe("assembling a draft", () => {
  it("each kind is saved under an existing allowed platform with the right shape", () => {
    expect(STUDIO_KINDS.map((k) => KIND_META[k].platform)).toEqual(["Instagram", "Facebook", "LinkedIn", "Amazon A+", "Email"]);
    const ig = assemblePost({ ...REQ, kind: "instagram_caption" }, GOOD as never, "openai");
    expect(ig).toMatchObject({ platform: "Instagram", title: "Instagram caption · Pearl hoop earrings", topic: "AI draft · Instagram caption · Pearl hoop earrings" });
    expect(ig.caption).toContain(BRAND_SIGNATURE);
    expect(ig.hashtags).toEqual(["#CheriAndCo", "#KoreanStyleJewellery", "#MinimalJewellery", "#EverydayJewellery"]);
    expect(ig.imageDirection).toBe(`Reference product image (link on file): ${IMAGE}`);
    const pd = assemblePost({ ...REQ, kind: "product_description" }, GOOD as never, "template");
    expect(pd.caption).toBe(GOOD.body); // a description carries no brand line
    expect(pd.topic).toMatch(/^Template draft/);
    const camp = assemblePost({ ...REQ, kind: "campaign_copy", theme: "A calm look" }, { headline: "Everyday pearls", body: GOOD.body }, "openai");
    expect(camp.caption.startsWith("Everyday pearls\n\n")).toBe(true);
    expect(camp.creativeBrief).toContain("A calm look");
  });
  it("template copy uses only the product's own words and passes the claim guard", () => {
    for (const kind of STUDIO_KINDS) {
      const post = assemblePost({ ...REQ, kind }, templateCopy({ ...REQ, kind }), "template");
      expect(findProhibitedClaims([post.caption, post.hashtags.join(" ")].join("\n")), kind).toEqual([]);
      expect(post.caption).toContain("Pearl hoop earrings");
    }
  });
});

describe("generator: AI gates, fallbacks and safety (fake transport only)", () => {
  it("AI on: one structured call, store=false, no tools, no image link or id in the input; the result is a draft with a review note", async () => {
    const t = fakeTransport(okBody(GOOD));
    const d = deps(t);
    const out = await runStudio(REQ, d);
    expect(out.generator).toBe("openai");
    expect(out.model).toBe("test-model");
    expect(out.post.caption).toContain("Small pearl hoops");
    expect(out.note).toMatch(/Check every line/);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body).toMatchObject({ store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(t.calls[0].body).not.toHaveProperty("tools");
    expect(JSON.stringify(t.calls[0].body)).not.toMatch(/img\.example\.com|aaaaaaaa-aaaa/);
    expect(d.ledger.rows).toHaveLength(1);
    expect(d.ledger.rows[0].action).toMatch(/^AI call v1 \| content \| test-model \| cost_usd=/);
  });
  it("AI off (default): the template is used and no call is made", async () => {
    const t = fakeTransport(okBody(GOOD));
    const out = await runStudio(REQ, deps(t, { config: cfg({ enabled: false }) }));
    expect(out.generator).toBe("template");
    expect(out.note).toMatch(/switched off/);
    expect(t.calls).toHaveLength(0);
    expect((await runStudio(REQ, null)).generator).toBe("template");
  });
  it("no API key, missing prices, spend cap, rate limit and an unreadable ledger all fall back to the template without calling", async () => {
    const t = fakeTransport(okBody(GOOD));
    expect((await runStudio(REQ, deps(null))).note).toMatch(/not configured/);
    expect((await runStudio(REQ, deps(t, { config: cfg({ priceInPerMTok: null }) }))).generator).toBe("template");
    expect((await runStudio(REQ, deps(t, { config: cfg({ monthlyBudgetUsd: 0 }) }))).note).toMatch(/spending limit/);
    expect((await runStudio(REQ, deps(t, { limiter: new CallRateLimiter(0) }))).note).toMatch(/too many requests/);
    const broken = new MemoryLedger(); broken.failReads = true;
    expect((await runStudio(REQ, deps(t, {}, broken))).note).toMatch(/usage limits/);
    expect(t.calls).toHaveLength(0);
  });
  it("a failed or unusable AI response falls back to the template and still counts toward the limits", async () => {
    for (const step of [new Error("down"), { status: 500, body: {} }, okBody({ body: "See https://x.com for pearl hoops", headline: "" }), okBody({ nope: true })]) {
      const t = fakeTransport(step as never);
      const d = deps(t);
      const out = await runStudio(REQ, d);
      expect(out.generator).toBe("template");
      expect(out.note).toMatch(/counted toward the usage limits/);
      expect(d.ledger.rows).toHaveLength(1);
    }
  });
  it("AI text with a price, offer, stock or material claim is DISCARDED, not edited", async () => {
    for (const body of ["Pearl hoops for just ₹499 today, lovely and light.", "Only 3 left, so grab these pearl hoops soon.", "Real sterling silver pearl hoops for you, truly.", "The best pearl hoops, guaranteed to be loved."]) {
      const t = fakeTransport(okBody({ headline: "", body }));
      const out = await runStudio(REQ, deps(t));
      expect(out.generator, body).toBe("template");
      expect(out.note).toMatch(/discarded/);
      expect(out.post.caption).not.toContain(body);
    }
  });
  it("a description that itself holds a refused claim is left out of the template rather than shipped", async () => {
    const out = await runStudio({ ...REQ, product: { ...REQ.product, description: "Real silver hoops at ₹499." } }, null);
    expect(out.post.caption).not.toMatch(/₹|silver/);
    expect(out.note).toMatch(/left out/);
  });
});

/* ---------- the live workflow, end to end, over the recording database ---------- */

const ENV = ["AUTH_MODE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "AI_ENABLED", "OPENAI_API_KEY", "OPENAI_PRICE_INPUT_USD_PER_MTOK", "OPENAI_PRICE_OUTPUT_USD_PER_MTOK", "OPENAI_MODEL"];
const headers = { host: "app.test", origin: "https://app.test", "content-type": "application/json" };
const jreq = (url: string, body?: unknown) => new Request(url, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
const generate = (body: unknown) => generateRoute(jreq("https://app.test/api/content-studio/generate", body));
const action = (id: string, a: string, body?: unknown) => socialAction(jreq(`https://app.test/api/social/posts/${id}/${a}`, body), { params: Promise.resolve({ id, action: a }) });
const setRole = (role: string) => { db.t.memberships = [{ user_id: "u1", org_id: ORG, role, organizations: { is_demo: false } }]; };
const mine = (table: string) => (db.t[table] ?? []).filter((r) => r.org_id === ORG);
const aiOn = () => { vi.stubEnv("AI_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real"); vi.stubEnv("OPENAI_PRICE_INPUT_USD_PER_MTOK", "2"); vi.stubEnv("OPENAI_PRICE_OUTPUT_USD_PER_MTOK", "8"); vi.stubEnv("OPENAI_MODEL", "test-model"); };

beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("AUTH_MODE", "required"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  db.reads.length = 0; db.n = 0; db.crash = ""; db.insertError = null;
  (globalThis as { __aiLimiter?: unknown }).__aiLimiter = undefined; // the per-minute limiter is process-wide; each test starts fresh
  const product = (over: Row) => ({ id: P1, org_id: ORG, sku: "CC-001", name: "Pearl hoop earrings", category: "Earrings", price: "1499.00", stock: 12, status: "active", channels: [], description: "Small pearl hoops. Comes in a gift box.", image_url: IMAGE, created_at: stamp, ...over });
  db.t = {
    memberships: [], profiles: [{ id: "u1", display_name: "Priya" }], approvals: [], content_items: [], agent_activity: [], audit_log: [],
    customers: [{ id: "c1", org_id: ORG, name: "Meera Kapoor", phone: "+91 98765 43210", email: "meera@x.com", created_at: stamp }],
    products: [product({}), product({ id: P_OTHER, org_id: OTHER_ORG, name: "Other org product" }), product({ id: P_ARCHIVED, name: "Old piece", status: "archived" })],
  };
  db.t.content_items.push({ id: POST_OTHER, org_id: OTHER_ORG, platform: "Facebook", title: "Other", topic: null, caption: "Other org text here", hashtags: [], creative_brief: null, image_direction: null, scheduled_for: null, status: "draft", approval_id: null, created_at: stamp });
  setRole("owner");
});
afterEach(() => { vi.unstubAllEnvs(); __setAiTransportForTests(undefined); });

describe("live workflow: product -> generate -> save -> edit -> regenerate -> approval -> activity", () => {
  it("runs the whole flow with a mock AI, saves in this organisation only, and records every step", async () => {
    aiOn();
    const t = fakeTransport(okBody(GOOD), okBody({ headline: "", body: "A softer take: small pearl hoops for everyday wear and easy gifting." }));
    __setAiTransportForTests(t.transport);

    // 1-2. Product selection + generation -> saved draft
    const res = await generate({ productId: P1, kind: "facebook_post", audience: "gifting", theme: "A calm look" });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { data: { id: string; platform: string; status: string; caption: string; topic: string }; generator: string };
    expect(made.generator).toBe("openai");
    expect(made.data).toMatchObject({ platform: "Facebook", status: "draft", topic: "AI draft · Facebook post · Pearl hoop earrings" });
    const row = mine("content_items").find((r) => r.id === made.data.id)!;
    expect(row).toMatchObject({ org_id: ORG, platform: "Facebook", status: "draft", approval_id: null });
    expect(String(row.caption)).toContain("Small pearl hoops");
    expect(t.calls).toHaveLength(1);
    expect(JSON.stringify(t.calls[0].body)).toContain("owner_description");

    // 3. Edit
    const edited = { title: "Pearl hoop earrings (edited)", topic: row.topic, platform: "Facebook", caption: "My own words about the pearl hoops.", hashtags: "#CheriAndCo", creativeBrief: "", imageDirection: "" };
    expect((await action(made.data.id, "edit", edited)).status).toBe(200);
    expect(mine("content_items").find((r) => r.id === made.data.id)).toMatchObject({ title: "Pearl hoop earrings (edited)", caption: "My own words about the pearl hoops.", status: "draft" });

    // 4. Regenerate the same draft (a second AI call, same row)
    const regen = await generate({ productId: P1, kind: "facebook_post", audience: "gifting", postId: made.data.id });
    expect(regen.status).toBe(200);
    expect(t.calls).toHaveLength(2);
    expect(mine("content_items")).toHaveLength(1);
    expect(String(mine("content_items")[0].caption)).toContain("A softer take");

    // 5. Submit for approval -> pending approval linked to the draft
    const sub = await action(made.data.id, "submit");
    expect(sub.status).toBe(200);
    const approval = mine("approvals")[0];
    expect(approval).toMatchObject({ org_id: ORG, status: "pending", generated_by: "content", type: "Content" });
    expect((approval.meta as { postId: string; kind: string })).toMatchObject({ postId: made.data.id, kind: "content_draft" });
    expect(String(approval.preview)).toContain("Source: AI draft · Facebook post · Pearl hoop earrings");
    expect(mine("content_items")[0]).toMatchObject({ status: "pending_approval", approval_id: approval.id });

    // a submitted draft cannot be regenerated, and no AI call is spent trying
    expect((await generate({ productId: P1, kind: "facebook_post", audience: "gifting", postId: made.data.id })).status).toBe(409);
    expect(t.calls).toHaveLength(2);

    // 6. Human decision -> content item follows, nothing is published
    const decided = await decideApproval(String(approval.id), "approve", "Looks right");
    expect(decided).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(mine("content_items")[0].status).toBe("approved");
    expect(mine("content_items")[0].status).not.toBe("published");
    expect(mine("audit_log")).toHaveLength(1);

    // 7. Activity history tells the whole story, in this organisation only
    const log = mine("agent_activity").map((r) => String(r.action));
    expect(log.some((a) => /^AI call v1 \| content \| test-model/.test(a))).toBe(true);
    expect(log).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Generated Facebook post for Pearl hoop earrings: AI draft \(test-model, studio-v1\)$/),
      "Edited draft: Pearl hoop earrings (edited)",
      expect.stringMatching(/^Regenerated Facebook post for Pearl hoop earrings: AI draft/),
      expect.stringMatching(/^Sent ".+" \(Facebook\) for approval$/),
      expect.stringMatching(/^Approved: Facebook post · Pearl hoop earrings/),
    ]));
    expect((await getActivities()).some((a) => /Generated Facebook post/.test(a.text))).toBe(true);
    expect(db.t.agent_activity.every((r) => r.org_id === ORG)).toBe(true);
  });

  it("a rejected draft can be edited and regenerated, and the rejection is in the history", async () => {
    aiOn();
    const t = fakeTransport(okBody(GOOD));
    __setAiTransportForTests(t.transport);
    const made = (await (await generate({ productId: P1, kind: "linkedin_post", audience: "work" })).json()) as { data: { id: string } };
    await action(made.data.id, "submit");
    const approvalId = String(mine("approvals")[0].id);
    expect(await decideApproval(approvalId, "reject", "Too plain")).toMatchObject({ ok: true, approval: { status: "rejected" } });
    expect(mine("content_items")[0].status).toBe("rejected");
    expect((await generate({ productId: P1, kind: "linkedin_post", audience: "work", postId: made.data.id })).status).toBe(200);
    expect(mine("content_items")[0]).toMatchObject({ status: "draft", approval_id: null });
    expect(mine("agent_activity").map((r) => String(r.action))).toEqual(expect.arrayContaining([expect.stringMatching(/^Rejected: /)]));
  });

  it("all five kinds save under their mapped platform", async () => {
    aiOn();
    __setAiTransportForTests(fakeTransport(okBody({ headline: "Everyday pearls", body: GOOD.body })).transport);
    const seen: string[] = [];
    for (const kind of STUDIO_KINDS) {
      const r = await generate({ productId: P1, kind, audience: "everyday" });
      expect(r.status, kind).toBe(201);
      seen.push(((await r.json()) as { data: { platform: string } }).data.platform);
    }
    expect(seen).toEqual(["Instagram", "Facebook", "LinkedIn", "Amazon A+", "Email"]);
  });

  it("AI off by default: a template draft is saved, no model call is made, and it is still a draft", async () => {
    const t = fakeTransport(okBody(GOOD));
    __setAiTransportForTests(t.transport);
    const r = await generate({ productId: P1, kind: "instagram_caption", audience: "everyday" });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { generator: string; note: string; data: { topic: string; status: string } };
    expect(body).toMatchObject({ generator: "template", data: { status: "draft" } });
    expect(body.data.topic).toMatch(/^Template draft/);
    expect(t.calls).toHaveLength(0);
    expect(mine("agent_activity").some((r2) => String(r2.action).startsWith("AI call v1"))).toBe(false);
  });

  it("AI off: the whole flow works on templates and never resolves the AI runtime, transport, key or ledger", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real"); // present, but AI_ENABLED is not true
    const t = fakeTransport(okBody(GOOD));
    __setAiTransportForTests(t.transport);
    const made = (await (await generate({ productId: P1, kind: "instagram_caption", audience: "everyday" })).json()) as { data: { id: string; caption: string; status: string }; generator: string };
    expect(made).toMatchObject({ generator: "template", data: { status: "draft" } });
    expect(made.data.caption).toContain("Pearl hoop earrings");
    expect(mine("content_items")).toHaveLength(1);
    expect((await action(made.data.id, "edit", { title: "T", topic: "Template draft · Instagram caption · Pearl hoop earrings", platform: "Instagram", caption: "Edited by a person.", hashtags: "#CheriAndCo", creativeBrief: "", imageDirection: "" })).status).toBe(200);
    expect((await generate({ productId: P1, kind: "instagram_caption", audience: "everyday", postId: made.data.id })).status).toBe(200);
    expect(mine("content_items")).toHaveLength(1);
    expect((await action(made.data.id, "submit")).status).toBe(200);
    expect(mine("approvals")[0]).toMatchObject({ status: "pending", org_id: ORG });
    expect(t.calls).toHaveLength(0);
    expect(mine("agent_activity").some((r) => String(r.action).startsWith("AI call v1"))).toBe(false);
    expect(mine("agent_activity").map((r) => String(r.action))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Generated Instagram caption for Pearl hoop earrings: Template draft$/), expect.stringMatching(/^Regenerated /), expect.stringMatching(/^Sent /),
    ]));
  });

  it("a database refusal or a code fault answers with JSON that says what kind of failure it was, and logs the real cause", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.insertError = { code: "23514", message: 'new row for relation "content_items" violates check constraint "x"' };
      const refused = await generate({ productId: P1, kind: "instagram_caption", audience: "everyday" });
      expect(refused.status).toBe(500);
      expect(((await refused.json()) as { error: string }).error).toMatch(/database refused/);
      expect(spy.mock.calls.flat().join(" ")).toMatch(/23514.*violates check constraint/);
      expect(mine("content_items")).toHaveLength(0);

      db.insertError = null; db.crash = "products";
      const crashed = await generate({ productId: P1, kind: "instagram_caption", audience: "everyday" });
      expect(crashed.status).toBe(500);
      const body = (await crashed.json()) as { error: string };
      expect(body.error).toMatch(/server error/);
      expect(JSON.stringify(body)).not.toMatch(/sk-|boom|TypeError/); // the page gets a safe message; the log gets the detail
      expect(spy.mock.calls.flat().join(" ")).toMatch(/TypeError: boom/);
    } finally { spy.mockRestore(); }
  });

  it("no customer record is read or sent: only the products table feeds the Studio", async () => {
    aiOn();
    const t = fakeTransport(okBody(GOOD));
    __setAiTransportForTests(t.transport);
    await generate({ productId: P1, kind: "facebook_post", audience: "everyday" });
    expect(db.reads).not.toContain("customers");
    expect(JSON.stringify(t.calls)).not.toMatch(/Meera|98765|meera@/);
  });

  it("organisation isolation: another organisation's product or draft is a 404 and costs nothing", async () => {
    aiOn();
    const t = fakeTransport(okBody(GOOD));
    __setAiTransportForTests(t.transport);
    expect((await generate({ productId: P_OTHER, kind: "facebook_post", audience: "everyday" })).status).toBe(404);
    expect((await generate({ productId: P1, kind: "facebook_post", audience: "everyday", postId: POST_OTHER })).status).toBe(404);
    expect((await generate({ productId: P_ARCHIVED, kind: "facebook_post", audience: "everyday" })).status).toBe(409);
    expect(t.calls).toHaveLength(0);
    expect(mine("content_items")).toHaveLength(0);
    expect((db.t.content_items.find((r) => r.id === POST_OTHER) as Row).caption).toBe("Other org text here");
  });

  it("permissions and validation: a viewer is refused, bad input is a 400, a demo organisation never reaches AI", async () => {
    aiOn();
    const t = fakeTransport(okBody(GOOD));
    __setAiTransportForTests(t.transport);
    setRole("viewer");
    expect((await generate({ productId: P1, kind: "facebook_post", audience: "everyday" })).status).toBe(403);
    setRole("staff");
    for (const bad of [{}, { productId: "nope", kind: "facebook_post" }, { productId: P1, kind: "poem" }, { productId: P1, kind: "facebook_post", audience: "robots" },
      { productId: P1, kind: "facebook_post", theme: "call 98765 43210" }, { productId: P1, kind: "facebook_post", postId: "x" }]) {
      expect((await generate(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    db.t.memberships = [{ user_id: "u1", org_id: ORG, role: "owner", organizations: { is_demo: true } }];
    expect((await generate({ productId: P1, kind: "facebook_post", audience: "everyday" })).status).toBe(404);
    expect(t.calls).toHaveLength(0);
    expect(mine("content_items")).toHaveLength(0);
  });

  it("a draft whose AI text breaks the claim guard is saved as a template draft and never as the AI text", async () => {
    aiOn();
    __setAiTransportForTests(fakeTransport(okBody({ headline: "", body: "Real sterling silver pearl hoops, guaranteed to last." })).transport);
    const r = await generate({ productId: P1, kind: "facebook_post", audience: "everyday" });
    const body = (await r.json()) as { generator: string; note: string };
    expect(body.generator).toBe("template");
    expect(body.note).toMatch(/discarded/);
    expect(String(mine("content_items")[0].caption)).not.toMatch(/sterling|guaranteed/);
  });
});
