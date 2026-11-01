/** The five agents and the orchestrator: simulated suggestions that wait for a human, private per visitor. */
import { readFileSync } from "node:fs";
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

import {
  addDiscoveredRetailer, createTaskFromSuggestion, decideApproval, getActionLinks, getActivities, getApprovals, getDeals, getDiscovery,
  getOrchestratorBrief, getRetailer, getRetailers, getSuggestions, getTasks, queueAgentAction,
} from "@/services";
import { store } from "@/services/store";
import { followUpEmail, followUpFor, pricePosition, qualificationFactors, scoreCandidate, temperatureFor } from "@/lib/agent-logic";
import { discoveryCandidates } from "@/mocks/agent-samples";
import { retailers } from "@/mocks/data";

const visit = (who: string) => { jars.state.who = who; };
beforeEach(() => { jars.all.clear(); visit("anon"); });

describe("agent suggestions go to the approval queue, never straight out", () => {
  it("B2C: a suggested reply becomes a pending approval built on the server", async () => {
    visit("A");
    const before = (await getApprovals()).length;
    const res = await queueAgentAction("b2c", "e1");
    expect(res).toMatchObject({ ok: true, approval: { type: "Instagram reply", generatedBy: "b2c", status: "pending" } });
    expect((await getApprovals()).length).toBe(before + 1);
    if (res.ok) expect(res.approval.title).toMatch(/^SAMPLE/);
  });

  it("B2B: a follow-up email is drafted, labelled not sent", async () => {
    visit("A");
    const res = await queueAgentAction("b2b", "r1");
    expect(res).toMatchObject({ ok: true, approval: { type: "B2B outreach", generatedBy: "b2b" } });
    if (res.ok) expect(res.approval.preview).toMatch(/not sent/i);
  });

  it("Amazon: a recommendation becomes a listing or pricing approval", async () => {
    visit("A");
    const price = await queueAgentAction("amazon", "am3"); // "cut price to ₹599"
    const listing = await queueAgentAction("amazon", "am2");
    expect(price).toMatchObject({ ok: true, approval: { type: "Pricing change", generatedBy: "amazon" } });
    expect(listing).toMatchObject({ ok: true, approval: { type: "Amazon listing" } });
    if (price.ok) expect(price.approval.preview).toMatch(/Nothing is changed on Amazon/);
  });

  it("refuses duplicates while pending, unknown records, and follows the human decision", async () => {
    visit("A");
    const first = await queueAgentAction("b2c", "e2");
    expect(await queueAgentAction("b2c", "e2")).toMatchObject({ ok: false, reason: "already_queued" });
    expect(await queueAgentAction("b2c", "nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect((await getActionLinks())["b2c:e2"].status).toBe("pending");
    if (!first.ok) throw new Error("setup");
    await decideApproval(first.approval.id, "approve", "demo");
    expect((await getActionLinks())["b2c:e2"].status).toBe("approved");
    expect(await queueAgentAction("b2c", "e2")).toMatchObject({ ok: true }); // can be queued again after a decision
  });
});

describe("B2B discovery and qualification", () => {
  it("lists SAMPLE candidates with visible, rule-based scores", async () => {
    const d = await getDiscovery();
    expect(d.candidates).toHaveLength(discoveryCandidates.length);
    expect(d.note).toMatch(/No search is run/);
    for (const c of d.candidates) {
      expect(c.business).toMatch(/^SAMPLE/);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(c.factors.length).toBeGreaterThan(0);
    }
  });

  it("adding a candidate creates a lead and a deal for that visitor only, once", async () => {
    visit("A");
    const res = await addDiscoveredRetailer("dc3");
    expect(res).toMatchObject({ ok: true, retailer: { id: "r-dc3" } });
    expect(await getRetailer("r-dc3")).not.toBeNull();
    expect((await getDeals()).some((d) => d.retailerId === "r-dc3")).toBe(true);
    expect(await addDiscoveredRetailer("dc3")).toMatchObject({ ok: false, reason: "exists" });
    expect(await addDiscoveredRetailer("zzz")).toMatchObject({ ok: false, reason: "not_found" });
    expect((await getDiscovery()).candidates.find((c) => c.id === "dc3")!.added).toBe(true);

    visit("B");
    expect(await getRetailer("r-dc3")).toBeNull();
    expect((await getRetailers()).length).toBe(retailers.length);
  });

  it("scores are bounded and ordered by fit, and every pipeline stage has a follow-up", () => {
    const strong = scoreCandidate({ stocksJewellery: true, tier: 1, hasInstagram: true, hasWebsite: true, stores: 3 });
    const weak = scoreCandidate({ stocksJewellery: false, tier: 3, hasInstagram: false, hasWebsite: false, stores: 1 });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.score).toBeLessThanOrEqual(100);
    expect(temperatureFor(strong.score)).toBe("HOT");
    expect(temperatureFor(weak.score)).toBe("COLD");
    for (const stage of ["new", "qualified", "contacted", "interested", "negotiation", "won", "lost"] as const) {
      expect(followUpFor({ stage, business: "X", temperature: "WARM", contact: "Asha Rao" }).title.length).toBeGreaterThan(5);
    }
    expect(qualificationFactors(retailers[0]).length).toBe(5);
  });

  it("the follow-up email states that prices and terms come from the client and that nothing was sent", () => {
    const mail = followUpEmail(retailers[0]);
    expect(mail).toMatch(/not sent/i);
    expect(mail).toMatch(/supplied by the client/);
    expect(mail).not.toMatch(/₹\d|%\s*off|discount/i);
  });
});

describe("CRM suggestions", () => {
  it("creates a task from a suggestion, once, and the suggestion then disappears", async () => {
    visit("A");
    const [first] = await getSuggestions();
    expect(first).toBeDefined();
    const openBefore = (await getTasks()).length;
    const task = await createTaskFromSuggestion(first.key);
    expect(task).toMatchObject({ title: first.title, status: "open" });
    expect((await getTasks()).length).toBe(openBefore + 1);
    expect((await getSuggestions()).some((s) => s.key === first.key)).toBe(false);
    expect(await createTaskFromSuggestion(first.key)).toBeNull();
    expect(await createTaskFromSuggestion("made-up")).toBeNull();
    visit("B");
    expect((await getTasks()).length).toBe(openBefore);
  });
});

describe("orchestrator", () => {
  it("summarises all five agents and updates as people act", async () => {
    visit("A");
    const before = await getOrchestratorBrief();
    expect(before.agents.map((a) => a.key)).toEqual(["b2c", "b2b", "amazon", "content", "crm"]);
    expect(before.recommendations.length).toBeGreaterThan(0);

    await queueAgentAction("b2b", "r1");
    await queueAgentAction("amazon", "am1");
    const after = await getOrchestratorBrief();
    expect(after.totals.pending).toBe(before.totals.pending + 2);
    expect(after.agents.find((a) => a.key === "b2b")!.pending).toBe(before.agents.find((a) => a.key === "b2b")!.pending + 1);
    expect(after.feed[0].text).toMatch(/Amazon|Proposed/);
    expect(new Set(after.feed.map((f) => f.agent).filter(Boolean)).size).toBeGreaterThan(1);
  });

  it("records approvals in the shared activity history", async () => {
    visit("A");
    const q = await queueAgentAction("b2c", "e3");
    if (!q.ok) throw new Error("setup");
    await decideApproval(q.approval.id, "approve", "Anika");
    expect((await getActivities())[0].text).toMatch(/Approved \(demo\)/);
    visit("B");
    expect((await getActivities())[0].text).not.toMatch(/Approved \(demo\)/);
  });

  it("never touches the shared sample data", async () => {
    const snapshot = JSON.stringify(store);
    visit("A");
    await queueAgentAction("b2b", "r2");
    await addDiscoveredRetailer("dc1");
    const [s] = await getSuggestions();
    await createTaskFromSuggestion(s.key);
    expect(JSON.stringify(store)).toBe(snapshot);
  });
});

describe("amazon helpers", () => {
  it("places a price within the market range", () => {
    expect(pricePosition(1499, 1099, 1699).pct).toBe(67);
    expect(pricePosition(500, 600, 700).pct).toBe(0);
    expect(pricePosition(900, 600, 700).pct).toBe(100);
  });
});

describe("demo labelling and no live calls", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("every agent page says its data is a SAMPLE and its actions are simulated", () => {
    for (const p of ["b2c", "b2b", "amazon", "crm"]) expect(read(`src/app/(app)/${p}/page.tsx`)).toMatch(/SAMPLE|SimBadge/);
    expect(read("src/components/agent-views.tsx")).toMatch(/recommends only/);
    expect(read("src/components/agent-actions.tsx")).toMatch(/\(demo\)/);
  });
  it("the new code contains no outbound network calls, provider names or secrets", () => {
    const src = ["src/lib/agent-logic.ts", "src/mocks/agent-samples.ts", "src/app/api/agent-actions/route.ts", "src/app/api/b2b/discover/route.ts",
      "src/app/api/crm/suggestions/route.ts", "src/app/api/orchestrator/brief/route.ts"].map(read).join("\n");
    expect(src).not.toMatch(/process\.env|anthropic|openai|twilio|whatsapp|googleapis|places\.google|sp-api|smtp|fetch\(/i);
    const client = read("src/components/agent-actions.tsx");
    const urls = [...client.matchAll(/["`](\/api\/[^"`]+)["`]/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("/api/"))).toBe(true);
  });
});
