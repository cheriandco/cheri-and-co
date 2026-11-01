/** Social media inside the Content & Marketing Agent: simulated only, labelled, claim-guarded, private per visitor. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const jars = vi.hoisted(() => {
  const all = new Map<string, Map<string, string>>();
  const state = { who: "anon" };
  const jar = (who: string) => all.get(who) ?? all.set(who, new Map()).get(who)!;
  return { all, state, jar };
});

vi.mock("next/headers", () => ({
  cookies: async () => {
    const j = jars.jar(jars.state.who);
    return {
      get: (n: string) => (j.has(n) ? { name: n, value: j.get(n)! } : undefined),
      set: (n: string, v: string) => { j.set(n, v); },
    };
  },
}));

vi.stubEnv("NODE_ENV", "production");

import { createSocialPost, decideApproval, getSocialPosts, simulatePublishSocialPost, submitSocialPost, updateSocialPost } from "@/services";
import { store } from "@/services/store";
import { ASSIST_LABEL, parseAssistInput, runAssist } from "@/lib/social/assist";
import { buildCalendar, normalizeHashtags, parsePostInput, toView } from "@/lib/social/posts";
import { socialPosts } from "@/mocks/social-samples";

const visit = (who: string) => { jars.state.who = who; };
beforeEach(() => { jars.all.clear(); visit("anon"); });

const draft = { title: "Hoops, three ways", topic: "Styling hoops", platform: "Instagram" as const, caption: "One pair of hoops, three moods.", hashtags: ["#CheriAndCo"], creativeBrief: "Three looks.", imageDirection: "Portrait crops." };
const find = async (id: string) => (await getSocialPosts()).find((p) => p.id === id)!;

describe("AI content assistance is clearly a demo", () => {
  it("labels every response as template-based with no model connected", () => {
    for (const mode of ["ideas", "caption", "brief"] as const) {
      const r = runAssist({ mode, platform: "Facebook", topic: "Earring Duo", caption: "" });
      expect(r.label).toBe(ASSIST_LABEL);
      expect(r.label).toMatch(/No AI model is connected/);
      expect(r.suggestions.length).toBeGreaterThan(0);
    }
  });
  it("is platform-specific and deterministic", () => {
    const a = runAssist({ mode: "ideas", platform: "Instagram", topic: "rings", caption: "" });
    const b = runAssist({ mode: "ideas", platform: "LinkedIn", topic: "rings", caption: "" });
    expect(a.suggestions).not.toEqual(b.suggestions);
    expect(runAssist({ mode: "ideas", platform: "Instagram", topic: "rings", caption: "" })).toEqual(a);
  });
  it("warns when the visitor's own text makes price or discount claims", () => {
    const r = runAssist({ mode: "caption", platform: "Instagram", topic: "50% off everything, only ₹299", caption: "" });
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("rejects empty input and unknown modes or platforms", () => {
    expect(parseAssistInput({ mode: "caption", platform: "Instagram" }).ok).toBe(false);
    expect(parseAssistInput({ mode: "write-my-essay", platform: "Instagram", topic: "x" }).ok).toBe(false);
    expect(parseAssistInput({ mode: "ideas", platform: "TikTok", topic: "x" }).ok).toBe(false);
  });
});

describe("validation", () => {
  it("accepts Instagram, Facebook and LinkedIn only", () => {
    expect(parsePostInput({ ...draft, platform: "Instagram" }).ok).toBe(true);
    expect(parsePostInput({ ...draft, platform: "LinkedIn" }).ok).toBe(true);
    expect(parsePostInput({ ...draft, platform: "TikTok" }).ok).toBe(false);
  });
  it("requires a title and bounds every field", () => {
    expect(parsePostInput({ ...draft, title: "  " }).ok).toBe(false);
    expect(parsePostInput({ ...draft, caption: "x".repeat(2201) }).ok).toBe(false);
    expect(parsePostInput({ ...draft, scheduledFor: "2026-13-45" }).ok).toBe(false);
    expect(parsePostInput({ ...draft, scheduledFor: "2026-12-05" }).ok).toBe(true);
    expect(parsePostInput(null).ok).toBe(false);
  });
  it("normalises hashtags", () => {
    expect(normalizeHashtags("#a, b  #A <script>")).toEqual(["#a", "#b", "#script"]);
    expect(normalizeHashtags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(30);
  });
});

describe("create → approve → simulate publish", () => {
  it("walks the whole workflow and posts nothing", async () => {
    visit("A");
    const p = await createSocialPost(draft);
    expect((await find(p.id)).status).toBe("draft");

    const edited = await updateSocialPost(p.id, { ...draft, caption: "Updated caption." });
    expect(edited).toMatchObject({ ok: true, post: { caption: "Updated caption.", status: "draft" } });

    expect(await simulatePublishSocialPost(p.id)).toMatchObject({ ok: false, reason: "invalid_state" });

    const sub = await submitSocialPost(p.id);
    expect(sub).toMatchObject({ ok: true, post: { status: "pending_approval" } });
    expect(await updateSocialPost(p.id, draft)).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await submitSocialPost(p.id)).toMatchObject({ ok: false, reason: "invalid_state" });

    const approvalId = (await find(p.id)).approvalId!;
    expect(await decideApproval(approvalId, "approve", "demo")).toMatchObject({ ok: true });
    expect((await find(p.id)).status).toBe("approved");

    const pub = await simulatePublishSocialPost(p.id);
    expect(pub).toMatchObject({ ok: true, post: { status: "simulated_published" } });
    expect((await find(p.id)).metrics?.reach).toBeGreaterThan(0);
  });

  it("a rejected post can be edited and resubmitted", async () => {
    visit("A");
    const p = await createSocialPost(draft);
    await submitSocialPost(p.id);
    await decideApproval((await find(p.id)).approvalId!, "reject", "demo", "not now");
    expect((await find(p.id)).status).toBe("rejected");
    expect(await updateSocialPost(p.id, { ...draft, caption: "Softer wording." })).toMatchObject({ ok: true, post: { status: "draft" } });
    expect(await submitSocialPost(p.id)).toMatchObject({ ok: true });
  });

  it("the claim guard blocks prices, offers and stock claims at submit", async () => {
    visit("A");
    const p = await createSocialPost({ ...draft, caption: "Flat 50% off, only ₹299, limited stock!" });
    const res = await submitSocialPost(p.id);
    expect(res).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect((await find(p.id)).status).toBe("draft");
  });

  it("will not submit a post with no caption, and unknown ids are 'not found'", async () => {
    visit("A");
    const p = await createSocialPost({ ...draft, caption: "" });
    expect(await submitSocialPost(p.id)).toMatchObject({ ok: false });
    expect(await submitSocialPost("nope")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("sample post sp5 follows its linked approval", async () => {
    visit("A");
    expect((await find("sp5")).status).toBe("pending_approval");
    await decideApproval("a1", "approve", "demo");
    expect((await find("sp5")).status).toBe("approved");
    visit("B");
    expect((await find("sp5")).status).toBe("pending_approval");
  });
});

describe("isolation", () => {
  it("one visitor's posts, approvals and simulated publishing are invisible to everyone else", async () => {
    const snapshot = JSON.stringify(store);
    visit("A");
    const p = await createSocialPost(draft);
    await submitSocialPost(p.id);
    expect((await getSocialPosts()).some((x) => x.id === p.id)).toBe(true);
    visit("B");
    expect((await getSocialPosts()).some((x) => x.id === p.id)).toBe(false);
    visit("anon");
    expect((await getSocialPosts()).length).toBe(socialPosts.length);
    expect(JSON.stringify(store)).toBe(snapshot);
  });
});

describe("calendar and sample data", () => {
  const today = new Date("2026-11-04T10:00:00Z"); // a Wednesday
  it("builds five Monday-first weeks, starting a week back, that include today", () => {
    const weeks = buildCalendar(socialPosts.map((p) => toView(p, today)), today);
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0].date).toBe("2026-10-26");
    expect(weeks.flat().filter((d) => d.isToday)).toHaveLength(1);
    expect(weeks.flat().flatMap((d) => d.posts).length).toBeGreaterThan(0);
  });
  it("covers every status the brief asks for, on the three platforms", () => {
    const views = socialPosts.map((p) => toView(p, today, p.approvalId ? "pending" : undefined)); // sp5 is linked to a pending approval
    const statuses = new Set(views.map((v) => v.status));
    for (const s of ["draft", "pending_approval", "approved", "rejected", "simulated_published"]) expect(statuses.has(s as never)).toBe(true);
    expect(new Set(views.map((v) => v.platform))).toEqual(new Set(["Instagram", "Facebook", "LinkedIn"]));
  });
  it("sample posts are marked SAMPLE and contain no prices or offers", () => {
    for (const p of socialPosts) {
      expect(p.isSample).toBe(true);
      expect(`${p.caption} ${p.creativeBrief}`).not.toMatch(/₹|\brs\.?\s*\d|%|\boff\b|discount|sale/i);
    }
  });
});

describe("nothing leaves the app", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
  it("the social code contains no network calls to platforms or AI providers, and reads no secrets", () => {
    const src = [...files("src/lib/social"), ...files("src/app/api/social"), "src/components/social.tsx", "src/components/social-views.tsx"]
      .map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/graph\.facebook|api\.instagram|api\.linkedin|anthropic|openai|canva|process\.env/i);
    // The only fetch calls are same-origin /api/social requests from the browser components.
    const fetches = [...src.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1].trim());
    expect(fetches.every((u) => u === "url")).toBe(true);
    expect(src).toMatch(/call<[^>]*>\(\s*[`"]\/api\/social/);
  });
  it("the UI says nothing is posted", () => {
    const ui = readFileSync("src/components/social.tsx", "utf8") + readFileSync("src/components/social-views.tsx", "utf8");
    expect(ui).toMatch(/nothing is posted/i);
    expect(ui).toContain("Simulate publish (demo)");
    expect(ui).toContain("Submit for approval (demo)");
  });
});
