/** Content & Marketing AI pilot: prompt and input, output validation, assembly, the claim guard on AI text, fallbacks, and the gate that keeps the
 *  public demo free of AI. Every model call here goes to a scripted fake transport; nothing touches the network or a database. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentPacks, contentProducts } from "@/mocks/content-samples";
import type { AiConfig } from "@/lib/ai/config";
import { CallRateLimiter } from "@/lib/ai/limits";
import { parseRunInput, type ContentRunInput } from "@/lib/content-agent";
import {
  CONTENT_INSTRUCTIONS, CONTENT_PROMPT_VERSION, CONTENT_SCHEMA, buildContentInput, parseContentAiOutput, validateContentAiParts,
} from "@/lib/content-agent/ai-prompt";
import { assembleAiDraft, runContentAgentAi, runContentAgentFromParts, type ContentAiDeps } from "@/lib/content-agent/ai";
import { generateContent } from "@/lib/content-agent/generate";
import { contentCategoryFor, contentProductFromProduct, liveContentProducts } from "@/lib/content-agent/live-source";
import { subjectFromProduct } from "@/lib/content-agent/subjects";
import type { ContentProduct } from "@/types/content-agent";
import type { Product } from "@/types";
import { GOOD_OUTPUT, MemoryLedger, fakeTransport, okBody } from "./helpers/fake-openai";

const h = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthUser: async () => h.user, DEMO_USER: { id: "demo" } }));
const sharedLedger = vi.hoisted(() => ({ rows: [] as { action: string; at: string }[] }));
vi.mock("@/services/ai-ledger", () => ({
  liveAiLedger: {
    usage: async (since: string) => sharedLedger.rows.filter((r) => r.at >= since),
    record: async (action: string) => { sharedLedger.rows.push({ action, at: new Date().toISOString() }); },
  },
}));

const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true, model: "test-model", maxOutputTokens: 1000, timeoutMs: 5000, monthlyBudgetUsd: 20, dailyCallsPerOrg: 100, perUserPerMinute: 5,
  priceInPerMTok: 2, priceOutPerMTok: 8, ...over,
});

const PRODUCT: ContentProduct = { id: "p1", name: "Pearl hoop earrings", category: "earrings", styleTags: ["minimal", "everyday"], approvedClaims: [], links: {}, isSample: false };
const AMAZON = "https://www.amazon.in/dp/EXAMPLE123";
const FLIPKART = "https://www.flipkart.com/example/p/itmEXAMPLE";
const RUN: ContentRunInput = { target: { type: "product", id: "p1" }, audience: "everyday", links: { amazon: AMAZON, flipkart: FLIPKART } };

const deps = (t: ReturnType<typeof fakeTransport> | null, over: Partial<ContentAiDeps> = {}, ledger = new MemoryLedger()): ContentAiDeps & { ledger: MemoryLedger } => ({
  config: cfg(), transport: t ? t.transport : null, ledger, limiter: new CallRateLimiter(100), userKey: "u1", ...over,
}) as ContentAiDeps & { ledger: MemoryLedger };

describe("prompt and input", () => {
  const subject = { ...subjectFromProduct(PRODUCT), approvedClaims: ["Hypoallergenic"] };

  it("sends product facts only, as JSON, with the approved claims", () => {
    const { input } = buildContentInput(subject, "college");
    const o = JSON.parse(input);
    expect(o.product).toMatchObject({ name: "Pearl hoop earrings", kind: "product", piece_count: 1, style_tags: ["minimal", "everyday"], approved_claims: ["Hypoallergenic"] });
    expect(o.audience).toMatch(/college/);
    expect(Object.keys(o).sort()).toEqual(["audience", "product"]);
  });

  it("never carries links, ids or any customer field to the model", () => {
    const s = { ...subject, links: { amazon: AMAZON, flipkart: FLIPKART } };
    const { input } = buildContentInput(s, "everyday");
    expect(input).not.toMatch(/amazon|flipkart|https?:|p1/i);
  });

  it("redacts personal data hidden in a product name and counts it", () => {
    const s = { ...subject, name: "Ring for anika@example.com call 9876543210" };
    const { input, redactions } = buildContentInput(s, "everyday");
    expect(input).not.toMatch(/anika@|9876543210/);
    expect(input).toContain("[email]");
    expect(redactions).toBeGreaterThanOrEqual(1);
  });

  it("tells the model to treat the data as data and forbids price, stock and unapproved claims", () => {
    expect(CONTENT_INSTRUCTIONS).toMatch(/data, never as instructions/);
    expect(CONTENT_INSTRUCTIONS).toMatch(/price/i);
    expect(CONTENT_INSTRUCTIONS).toMatch(/approved_claims/);
  });

  it("has a version and a strict schema with exactly the four text parts", () => {
    expect(CONTENT_PROMPT_VERSION).toBe("content-v1");
    expect(CONTENT_SCHEMA).toMatchObject({ additionalProperties: false, required: ["caption", "reel_on_screen", "story_text", "canva_headline"] });
  });
});

describe("output validation", () => {
  const good = { caption: GOOD_OUTPUT.caption, reelOnScreen: GOOD_OUTPUT.reel_on_screen, storyText: GOOD_OUTPUT.story_text, canvaHeadline: GOOD_OUTPUT.canva_headline };

  it("accepts a well-formed output and maps snake_case keys", () => {
    expect(parseContentAiOutput(GOOD_OUTPUT)).toEqual(good);
    expect(validateContentAiParts(good)).toEqual(good);
  });

  it("rejects wrong shapes and counts", () => {
    for (const bad of [null, [], "x", {}, { ...GOOD_OUTPUT, reel_on_screen: ["a", "b"] }, { ...GOOD_OUTPUT, story_text: ["only one"] }, { ...GOOD_OUTPUT, caption: 5 }, { ...GOOD_OUTPUT, canva_headline: "" }]) {
      expect(parseContentAiOutput(bad)).toBeNull();
    }
  });

  it("rejects links, hashtags, handles, personal data, markup and control characters", () => {
    const withCaption = (caption: string) => ({ ...GOOD_OUTPUT, caption: `${GOOD_OUTPUT.caption} ${caption}` });
    for (const x of ["Shop at www.amazon.in now", "See https://x.example/y", "Find us at shop.com", "#minimal", "@cheri.co", "Call 98765 43210", "Mail me a@b.co", "<b>bold</b>", "use `code`", "bell\u0007"]) {
      expect(parseContentAiOutput(withCaption(x)), x).toBeNull();
    }
    expect(parseContentAiOutput({ ...GOOD_OUTPUT, reel_on_screen: ["Line one", "two\nlines", "three"] })).toBeNull();
    expect(parseContentAiOutput({ ...GOOD_OUTPUT, story_text: ["#tag", "fine"] })).toBeNull();
  });

  it("enforces length limits", () => {
    expect(parseContentAiOutput({ ...GOOD_OUTPUT, caption: "x".repeat(901) })).toBeNull();
    expect(parseContentAiOutput({ ...GOOD_OUTPUT, caption: "too short" })).toBeNull();
    expect(parseContentAiOutput({ ...GOOD_OUTPUT, reel_on_screen: ["a".repeat(61), "b", "c"] })).toBeNull();
    expect(parseContentAiOutput({ ...GOOD_OUTPUT, canva_headline: "h".repeat(81) })).toBeNull();
  });
});

describe("assembling an AI draft", () => {
  const subject = subjectFromProduct({ ...PRODUCT, links: { amazon: AMAZON, flipkart: FLIPKART } });
  const base = generateContent(subject, { audience: "everyday" });
  const parts = parseContentAiOutput(GOOD_OUTPUT)!;
  const d = assembleAiDraft(base, subject, parts, { model: "test-model", redactions: 2 });

  it("replaces only the text parts and keeps code-built structure", () => {
    expect(d.instagramCaption).toContain(GOOD_OUTPUT.caption);
    expect(d.reelScript.scenes.slice(0, 3).map((s) => s.onScreenText)).toEqual(GOOD_OUTPUT.reel_on_screen);
    expect(d.story.slice(0, 2).map((s) => s.text)).toEqual(GOOD_OUTPUT.story_text);
    expect(d.canvaBrief.headline).toBe(GOOD_OUTPUT.canva_headline);
    expect(d.hashtags).toEqual(base.hashtags);
    expect(d.cta).toEqual(base.cta);
    expect(d.instagramCaption).toContain(AMAZON);
    expect(d.instagramCaption).toContain(base.hashtags[0]);
  });

  it("records provenance and never marks the draft verified or published", () => {
    expect(d.generator).toBe("openai");
    expect(d.ai).toMatchObject({ model: "test-model", promptVersion: CONTENT_PROMPT_VERSION, redactions: 2 });
    expect(d.dataSource.verified).toBe(false);
    expect(d.published).toBe(false);
    expect(d.status).toBe("ai_generated");
    expect(d.issues.some((i) => i.code === "ai_generated")).toBe(true);
  });

  it("does not mutate the template draft it was built from", () => {
    expect(base.generator).toBe("template");
    expect(base.ai).toBeUndefined();
  });

  it("re-runs the claim guard on AI text", () => {
    const bad = assembleAiDraft(base, subject, { ...parts, caption: "Waterproof and tarnish-free, the best ring you will own." }, { model: "m", redactions: 0 });
    expect(bad.blocked).toBe(true);
    expect(bad.issues.some((i) => i.code === "prohibited_claim")).toBe(true);
  });

  it("lets an approved claim through but nothing else", () => {
    const s = { ...subject, approvedClaims: ["Hypoallergenic"] };
    const b = generateContent(s, { audience: "everyday" });
    const ok = assembleAiDraft(b, s, { ...parts, caption: "A gentle everyday piece. Hypoallergenic, as approved by the brand." }, { model: "m", redactions: 0 });
    expect(ok.issues.some((i) => i.code === "prohibited_claim")).toBe(false);
  });
});

describe("runContentAgentAi", () => {
  it("returns the template and makes NO call when AI is disabled", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const r = await runContentAgentAi(RUN, [PRODUCT], [], deps(t, { config: cfg({ enabled: false }) }));
    expect(r.ok && r.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(0);
  });

  it("returns the template and makes NO call without prices", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const r = await runContentAgentAi(RUN, [PRODUCT], [], deps(t, { config: cfg({ priceInPerMTok: null }) }));
    expect(r.ok && r.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(0);
  });

  it("falls back with a note when no API key is configured", async () => {
    const r = await runContentAgentAi(RUN, [PRODUCT], [], deps(null));
    expect(r.ok && r.draft.generator).toBe("template");
    expect(r.ok && r.note).toMatch(/not configured/);
  });

  it("writes an AI draft on success, with one call and one ledger row", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const d = deps(t);
    const r = await runContentAgentAi(RUN, [PRODUCT], [], d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.generator).toBe("openai");
    expect(r.draft.published).toBe(false);
    expect(r.draft.ai?.model).toBe("test-model");
    expect(t.calls).toHaveLength(1);
    expect(d.ledger.rows).toHaveLength(1);
    expect(d.ledger.rows[0].agent).toBe("content");
  });

  it("sends redacted facts only: no links, no email, no phone", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const dirty = { ...PRODUCT, name: "Ring for a@b.co 9876543210" };
    await runContentAgentAi(RUN, [dirty], [], deps(t));
    const sent = JSON.stringify(t.calls[0].body);
    expect(sent).not.toMatch(/a@b\.co|9876543210|amazon|flipkart|https?:/i);
    expect(t.calls[0].body.store).toBe(false);
  });

  it("does not spend on a draft that is already blocked", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const r = await runContentAgentAi({ ...RUN, links: { amazon: "http://evil.example/x" } }, [PRODUCT], [], deps(t));
    expect(r.ok && r.draft.blocked).toBe(true);
    expect(r.ok && r.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(0);
  });

  it("returns an error for an unknown product without calling the model", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    expect(await runContentAgentAi({ ...RUN, target: { type: "product", id: "nope" } }, [PRODUCT], [], deps(t))).toEqual({ ok: false, error: "Unknown product." });
    expect(t.calls).toHaveLength(0);
  });

  it("falls back, keeps the spend recorded, and explains when the call fails", async () => {
    const t = fakeTransport({ status: 500, body: null });
    const d = deps(t);
    const r = await runContentAgentAi(RUN, [PRODUCT], [], d);
    expect(r.ok && r.draft.generator).toBe("template");
    expect(r.ok && r.note).toMatch(/counted toward/);
    expect(d.ledger.rows).toHaveLength(1);
  });

  it("falls back when the model returns unusable text (link inside)", async () => {
    const t = fakeTransport(okBody({ ...GOOD_OUTPUT, caption: `${GOOD_OUTPUT.caption} Buy at https://x.example` }));
    const r = await runContentAgentAi(RUN, [PRODUCT], [], deps(t));
    expect(r.ok && r.draft.generator).toBe("template");
  });

  it("DISCARDS an AI draft that contains prohibited claims, rather than editing it", async () => {
    const t = fakeTransport(okBody({ ...GOOD_OUTPUT, caption: "Waterproof, tarnish-free and the best ring ever, guaranteed for life." }));
    const r = await runContentAgentAi(RUN, [PRODUCT], [], deps(t));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.generator).toBe("template");
    expect(r.draft.blocked).toBe(false);
    expect(copyOf(r.draft)).not.toMatch(/waterproof|tarnish|guarantee/i);
    expect(r.note).toMatch(/discarded/);
  });

  it("falls back when the daily limit or the per-minute limit is reached, without calling the model", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const ledger = new MemoryLedger();
    const d = deps(t, { config: cfg({ dailyCallsPerOrg: 1 }) }, ledger);
    expect((await runContentAgentAi(RUN, [PRODUCT], [], d)).ok).toBe(true);
    const second = await runContentAgentAi(RUN, [PRODUCT], [], d);
    expect(second.ok && second.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(1);

    const t2 = fakeTransport(okBody(GOOD_OUTPUT));
    const d2 = deps(t2, { limiter: new CallRateLimiter(1) });
    await runContentAgentAi(RUN, [PRODUCT], [], d2);
    const again = await runContentAgentAi(RUN, [PRODUCT], [], d2);
    expect(again.ok && again.draft.generator).toBe("template");
    expect(t2.calls).toHaveLength(1);
  });

  it("falls back when the ledger cannot be read or written (fails closed)", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const ledger = new MemoryLedger(); ledger.failWrites = true;
    const r = await runContentAgentAi(RUN, [PRODUCT], [], deps(t, {}, ledger));
    expect(r.ok && r.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(0);
  });

  it("works for a pack and sends the member names", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const pack = contentPacks[0];
    const r = await runContentAgentAi({ ...RUN, target: { type: "pack", id: pack.id } }, contentProducts, contentPacks, deps(t));
    expect(r.ok && r.draft.generator).toBe("openai");
    expect(JSON.parse(t.calls[0].body.input as string).product.pack_contents.length).toBe(pack.size);
  });
});

const copyOf = (d: { instagramCaption: string }) => d.instagramCaption;

describe("submit: rebuilding from browser-supplied parts", () => {
  const parts = parseContentAiOutput(GOOD_OUTPUT)!;

  it("rebuilds the draft from valid parts with no model call", () => {
    const r = runContentAgentFromParts({ ...RUN, aiParts: parts }, [PRODUCT], [], "test-model");
    expect(r.ok && r.draft.generator).toBe("openai");
  });

  it("re-guards the parts: a tampered caption is blocked", () => {
    const r = runContentAgentFromParts({ ...RUN, aiParts: { ...parts, caption: "Guaranteed waterproof forever. The best jewellery." } }, [PRODUCT], [], "m");
    expect(r.ok && r.draft.blocked).toBe(true);
  });

  it("needs parts and a known product", () => {
    expect(runContentAgentFromParts(RUN, [PRODUCT], [], "m")).toEqual({ ok: false, error: "No AI-written text to rebuild." });
    expect(runContentAgentFromParts({ ...RUN, target: { type: "product", id: "nope" }, aiParts: parts }, [PRODUCT], [], "m").ok).toBe(false);
  });

  it("parseRunInput validates browser-supplied aiParts", () => {
    const body = { targetType: "product", targetId: "p1", audience: "everyday", aiParts: { caption: GOOD_OUTPUT.caption, reelOnScreen: GOOD_OUTPUT.reel_on_screen, storyText: GOOD_OUTPUT.story_text, canvaHeadline: GOOD_OUTPUT.canva_headline } };
    expect(parseRunInput(body)).toMatchObject({ ok: true, input: { aiParts: { canvaHeadline: GOOD_OUTPUT.canva_headline } } });
    expect(parseRunInput({ ...body, aiParts: { ...body.aiParts, caption: "Visit https://x.example please now" } })).toEqual({ ok: false, error: "The AI-written text did not pass the safety checks." });
    expect(parseRunInput({ ...body, aiParts: null })).toMatchObject({ ok: true });
  });
});

describe("the gate: who may use AI", () => {
  const ENV_KEYS = ["AUTH_MODE", "AI_ENABLED", "OPENAI_API_KEY", "OPENAI_PRICE_INPUT_USD_PER_MTOK", "OPENAI_PRICE_OUTPUT_USD_PER_MTOK"];
  const saved: Record<string, string | undefined> = {};
  const LIVE_USER = { id: "u1", email: "u@x.invalid", name: "U", role: "owner", orgId: "o1", isDemoOrg: false };

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    sharedLedger.rows.length = 0;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    const { __setAiTransportForTests } = await import("@/services/content-ai");
    __setAiTransportForTests(undefined);
  });

  const enable = () => {
    process.env.AUTH_MODE = "required"; process.env.AI_ENABLED = "true"; process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_PRICE_INPUT_USD_PER_MTOK = "2"; process.env.OPENAI_PRICE_OUTPUT_USD_PER_MTOK = "8";
  };

  it("the public demo never uses AI, even with every switch on and a transport present", async () => {
    const { runContentDraft, __setAiTransportForTests } = await import("@/services/content-ai");
    process.env.AUTH_MODE = "demo"; process.env.AI_ENABLED = "true"; process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_PRICE_INPUT_USD_PER_MTOK = "2"; process.env.OPENAI_PRICE_OUTPUT_USD_PER_MTOK = "8";
    h.user = { id: "demo", email: "", name: "Anika", role: "owner", orgId: "demo", isDemoOrg: true };
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    __setAiTransportForTests(t.transport);
    const r = await runContentDraft({ ...RUN, target: { type: "product", id: contentProducts[0].id } }, contentProducts, contentPacks);
    expect(r.ok && r.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(0);
  });

  it("a signed-out visitor or a demo organisation never uses AI", async () => {
    const { runContentDraft, __setAiTransportForTests } = await import("@/services/content-ai");
    enable();
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    __setAiTransportForTests(t.transport);
    for (const u of [null, { ...LIVE_USER, isDemoOrg: true }, { ...LIVE_USER, role: null }, { ...LIVE_USER, orgId: null }]) {
      h.user = u;
      const r = await runContentDraft(RUN, [PRODUCT], []);
      expect(r.ok && r.draft.generator).toBe("template");
    }
    expect(t.calls).toHaveLength(0);
  });

  it("a live organisation with AI off gets the template", async () => {
    const { runContentDraft, __setAiTransportForTests } = await import("@/services/content-ai");
    enable(); process.env.AI_ENABLED = "false";
    h.user = LIVE_USER;
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    __setAiTransportForTests(t.transport);
    const r = await runContentDraft(RUN, [PRODUCT], []);
    expect(r.ok && r.draft.generator).toBe("template");
    expect(t.calls).toHaveLength(0);
  });

  it("a live organisation with everything configured gets an AI draft through the fake transport", async () => {
    const { runContentDraft, __setAiTransportForTests } = await import("@/services/content-ai");
    enable();
    h.user = LIVE_USER;
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    __setAiTransportForTests(t.transport);
    const r = await runContentDraft(RUN, [PRODUCT], []);
    expect(r.ok && r.draft.generator).toBe("openai");
    expect(t.calls).toHaveLength(1);
    expect(sharedLedger.rows).toHaveLength(1);
  });

  it("aiPartsAllowed follows the same gates and never needs a key", async () => {
    const { aiPartsAllowed } = await import("@/services/content-ai");
    enable(); delete process.env.OPENAI_API_KEY;
    h.user = LIVE_USER;
    expect((await aiPartsAllowed()).allowed).toBe(true);
    h.user = { ...LIVE_USER, isDemoOrg: true };
    expect((await aiPartsAllowed()).allowed).toBe(false);
    h.user = LIVE_USER; process.env.AI_ENABLED = "false";
    expect((await aiPartsAllowed()).allowed).toBe(false);
  });
});

describe("live catalogue source", () => {
  const prod = (over: Partial<Product>): Product => ({ id: "x", sku: "S", name: "N", category: "Earrings", price: 100, stock: 3, status: "active", channels: [], ...over }) as Product;

  it("maps free-text categories to the agent's fixed ones", () => {
    expect(contentCategoryFor("Pearl Earrings")).toBe("earrings");
    expect(contentCategoryFor("Hoops")).toBe("earrings");
    expect(contentCategoryFor("Pendant necklace")).toBe("chain_pendant");
    expect(contentCategoryFor("Rings")).toBe("ring");
    expect(contentCategoryFor("Bracelet")).toBe("bracelet");
    expect(contentCategoryFor("Hair clip")).toBe("hair_accessory");
    expect(contentCategoryFor("Mystery")).toBeUndefined();
    expect(contentCategoryFor(null)).toBeUndefined();
  });

  it("invents nothing: no style tags, material, claims or links, never a sample", () => {
    const p = contentProductFromProduct(prod({ id: "abc", name: "Moon ring", category: "Rings" }));
    expect(p).toEqual({ id: "abc", name: "Moon ring", category: "ring", styleTags: [], approvedClaims: [], links: {}, isSample: false });
  });

  it("never passes price or stock to the content agent", () => {
    expect(JSON.stringify(contentProductFromProduct(prod({ price: 4999, stock: 2, sku: "SECRET-SKU" })))).not.toMatch(/4999|SECRET-SKU/);
  });

  it("drops archived products", () => {
    expect(liveContentProducts([prod({ id: "a" }), prod({ id: "b", status: "archived" })]).map((x) => x.id)).toEqual(["a"]);
  });
});
