/** Demo safety: every visitor works on a private copy of the sample data, and the demo labelling is in place. */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the browser cookie jar: `visit(name)` switches which browser is making the request. */
const jars = vi.hoisted(() => {
  const all = new Map<string, Map<string, string>>();
  const state = { who: "anon", setCalls: [] as { name: string; options: Record<string, unknown> }[] };
  const jar = (who: string) => all.get(who) ?? all.set(who, new Map()).get(who)!;
  return { all, state, jar };
});

vi.mock("next/headers", () => ({
  cookies: async () => {
    const j = jars.jar(jars.state.who);
    return {
      get: (n: string) => (j.has(n) ? { name: n, value: j.get(n)! } : undefined),
      set: (n: string, v: string, options: Record<string, unknown>) => { j.set(n, v); jars.state.setCalls.push({ name: n, options }); },
    };
  },
}));

// Outside a request the services fall back to a shared test copy; inside one (this file) they must not.
vi.stubEnv("NODE_ENV", "production");

import { createTask, decideApproval, getApprovals, getDashboardSummary, getDeals, getTasks, moveDeal, updateTask } from "@/services";
import { store } from "@/services/store";

const visit = (who: string) => { jars.state.who = who; };
const pending = async () => (await getApprovals()).filter((a) => a.status === "pending").map((a) => a.id);

beforeEach(() => { jars.all.clear(); jars.state.setCalls = []; visit("anon"); });

describe("one visitor never affects another", () => {
  it("approving as visitor A leaves visitor B and newcomers untouched", async () => {
    visit("A");
    const before = await pending();
    const id = before[0];
    expect(await decideApproval(id, "approve", "demo")).toMatchObject({ ok: true });
    expect(await pending()).not.toContain(id);

    visit("B");
    expect(await pending()).toEqual(before);
    visit("anon");
    expect(await pending()).toEqual(before);
  });

  it("A's approval is still there after B acts (state is kept per visitor)", async () => {
    visit("A");
    const [id] = await pending();
    await decideApproval(id, "reject", "demo", "no");
    visit("B");
    await decideApproval(id, "approve", "demo");
    visit("A");
    expect((await getApprovals()).find((a) => a.id === id)!.status).toBe("rejected");
    visit("B");
    expect((await getApprovals()).find((a) => a.id === id)!.status).toBe("approved");
  });

  it("tasks and pipeline moves are private too", async () => {
    visit("A");
    const t = await createTask({ title: "A's task", due: "d", assignee: "x", priority: "low" });
    await updateTask("t1", { status: "done" });
    const { id: dealId, stage: dealStage } = (await getDeals())[0];
    await moveDeal(dealId, dealStage === "won" ? "lost" : "won");

    visit("B");
    expect((await getTasks()).some((x) => x.id === t.id)).toBe(false);
    expect((await getTasks()).find((x) => x.id === "t1")!.status).toBe("open");
    expect((await getDeals()).find((d) => d.id === dealId)!.stage).toBe(dealStage);
    const summary = await getDashboardSummary();
    expect(summary.kpis.find((k) => k.id === "appr")!.value).toBe((await pending()).length);
  });

  it("the shared sample data is never modified while serving requests", async () => {
    const snapshot = JSON.stringify(store);
    visit("A");
    await decideApproval((await pending())[0], "approve", "demo");
    await createTask({ title: "x", due: "d", assignee: "x", priority: "low" });
    await moveDeal((await getDeals())[0].id, "lost");
    expect(JSON.stringify(store)).toBe(snapshot);
  });

  it("a visitor cookie is httpOnly, same-site, scoped and short-lived, and carries no personal data", async () => {
    visit("A");
    await decideApproval((await pending())[0], "approve", "demo");
    const set = jars.state.setCalls.at(-1)!;
    expect(set.name).toBe("cheri_demo_visitor");
    expect(set.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 7200 });
    expect(jars.jar("A").get("cheri_demo_visitor")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a forged, guessed or malformed visitor cookie sees only the pristine sample data", async () => {
    visit("A");
    const before = await pending();
    await decideApproval(before[0], "approve", "demo");
    for (const bad of ["../../etc/passwd", "00000000-0000-4000-8000-000000000000", ""]) {
      visit("M");
      jars.jar("M").set("cheri_demo_visitor", bad);
      expect(await pending()).toEqual(before);
    }
  });
});

describe("demo labelling", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the banner is in the root layout, so it covers every route", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("DEMO ENVIRONMENT");
    expect(layout).toContain("SAMPLE DATA");
    expect(layout).toContain("NOT CONNECTED TO LIVE BUSINESS SYSTEMS");
  });
  it("no page or sample notification claims a live Instagram connection", () => {
    const settings = read("src/app/(app)/settings/page.tsx");
    expect(settings).toContain("Not connected (demo)");
    expect(settings).not.toMatch(/Expires in/);
    expect(read("src/mocks/data.ts")).not.toMatch(/token expires/i);
  });
  it("approve and reject are labelled as simulated", () => {
    const ui = read("src/components/interactive.tsx");
    expect(ui).toContain("Approve (demo)");
    expect(ui).toContain("Reject (demo)");
    expect(ui).toMatch(/Simulated demo actions/);
  });
});
