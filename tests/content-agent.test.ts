import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentPacks, contentProducts } from "@/mocks/content-samples";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { chooseGenerator, isClaudeRequested } from "@/lib/content-agent/config";
import { copyText, generateContent } from "@/lib/content-agent/generate";
import { parseRunInput, runContentAgent } from "@/lib/content-agent";
import { checkMarketplaceLink } from "@/lib/content-agent/links";
import { MAX_PREVIEW_LENGTH, renderDraft } from "@/lib/content-agent/render";
import { resolveSubject, subjectFromPack, subjectFromProduct, validatePack } from "@/lib/content-agent/subjects";
import { canTransition, workflowStatus, WORKFLOW_LABEL } from "@/lib/content-agent/workflow";
import { decideApproval, getApprovals, submitContentDraft } from "@/services";
import { store } from "@/services/store";
import { approvals as mockApprovals, brandRules } from "@/mocks/data";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACK_SIZES, type ContentSubject } from "@/types/content-agent";

const AMAZON = "https://www.amazon.in/dp/EXAMPLE123";
const FLIPKART = "https://www.flipkart.com/example/p/itmEXAMPLE";

const subject = (over: Partial<ContentSubject> = {}): ContentSubject => ({
  kind: "product", name: "Test Piece", pieceCount: 1, categories: ["ring"], memberCategories: ["ring"], memberNames: ["Test Piece"],
  styleTags: ["minimal"], approvedClaims: [], links: {}, isSample: false, ...over,
});

const allSubjects = () => [
  ...contentProducts.map(subjectFromProduct),
  ...contentPacks.map((p) => subjectFromPack(p, contentProducts)),
];

describe("sample products and packs", () => {
  it("labels every record as SAMPLE", () => {
    for (const p of contentProducts) { expect(p.isSample).toBe(true); expect(p.id).toMatch(/^SAMPLE-P-\d{3}$/); }
    for (const p of contentPacks) { expect(p.isSample).toBe(true); expect(p.id).toMatch(/^SAMPLE-PACK-\d{3}$/); }
  });

  it("covers single pieces and the 2, 3, 6 and 10-piece packs", () => {
    expect(contentProducts.length).toBeGreaterThanOrEqual(10);
    expect([...contentPacks.map((p) => p.size)].sort((a, b) => a - b)).toEqual([2, 3, 6, 10]);
    expect([...PACK_SIZES]).toEqual([2, 3, 6, 10]);
  });

  it("builds every sample pack validly", () => {
    for (const pack of contentPacks) {
      expect(validatePack(pack, contentProducts)).toEqual([]);
      expect(pack.memberProductIds).toHaveLength(pack.size);
    }
  });

  it("never carries prices, stock, materials, claims or links", () => {
    for (const rec of [...contentProducts, ...contentPacks]) {
      expect(Object.keys(rec)).not.toEqual(expect.arrayContaining(["price"]));
      expect(Object.keys(rec)).not.toContain("stock");
      expect(rec.approvedClaims).toEqual([]);
      expect(rec.links).toEqual({});
    }
    for (const p of contentProducts) expect(p.materialNote).toBeUndefined();
  });

  it("rejects malformed packs", () => {
    const base = contentPacks[1];
    expect(validatePack({ ...base, size: 3, memberProductIds: base.memberProductIds.slice(0, 2) }, contentProducts)[0]).toMatch(/lists 2 pieces/);
    expect(validatePack({ ...base, memberProductIds: ["SAMPLE-P-001", "SAMPLE-P-001", "SAMPLE-P-002"] }, contentProducts).join(" ")).toMatch(/more than once/);
    expect(validatePack({ ...base, memberProductIds: ["SAMPLE-P-001", "SAMPLE-P-002", "NOPE"] }, contentProducts).join(" ")).toMatch(/unknown product/);
    expect(validatePack({ ...base, size: 4 as never, memberProductIds: ["a", "b", "c", "d"] }, contentProducts).join(" ")).toMatch(/not supported/);
  });

  it("resolves targets and refuses unknown ones", () => {
    expect(resolveSubject({ type: "product", id: "SAMPLE-P-001" }, contentProducts, contentPacks).ok).toBe(true);
    expect(resolveSubject({ type: "pack", id: "SAMPLE-PACK-004" }, contentProducts, contentPacks)).toMatchObject({ ok: true, subject: { pieceCount: 10 } });
    expect(resolveSubject({ type: "product", id: "nope" }, contentProducts, contentPacks).ok).toBe(false);
    expect(resolveSubject({ type: "pack", id: "nope" }, contentProducts, contentPacks).ok).toBe(false);
  });
});

describe("content generation", () => {
  it("produces every content type for each sample record", () => {
    for (const s of allSubjects()) {
      const d = generateContent(s);
      expect(d.instagramCaption.length).toBeGreaterThan(20);
      expect(d.hashtags.length).toBeGreaterThanOrEqual(3);
      expect(d.reelScript.scenes.length).toBeGreaterThanOrEqual(4);
      expect(d.asmrScript.cues.length).toBeGreaterThanOrEqual(4);
      expect(d.story).toHaveLength(3);
      expect(d.canvaBrief.formats.length).toBeGreaterThan(0);
      expect(d.canvaBrief.headline).toContain(s.name);
      expect(d.status).toBe("ai_generated");
      expect(d.published).toBe(false);
      expect(d.blocked).toBe(false);
    }
  });

  it("is deterministic", () => {
    const s = subjectFromPack(contentPacks[0], contentProducts);
    expect(generateContent(s, { audience: "college" })).toEqual(generateContent(s, { audience: "college" }));
  });

  it("describes packs by piece count and member categories only", () => {
    const d = generateContent(subjectFromPack(contentPacks[0], contentProducts));
    expect(d.instagramCaption).toContain("2 pieces");
    expect(d.instagramCaption).toContain("2 × earrings");
    const ten = generateContent(subjectFromPack(contentPacks[3], contentProducts));
    expect(ten.instagramCaption).toContain("10 pieces");
    expect(ten.canvaBrief.headline).toContain("10-piece combo");
  });

  it("keeps hashtags valid, unique and bounded, and the caption within Instagram's limit", () => {
    for (const s of allSubjects()) {
      const d = generateContent(s, { audience: "gifting" });
      expect(d.hashtags.length).toBeLessThanOrEqual(8);
      expect(new Set(d.hashtags).size).toBe(d.hashtags.length);
      for (const h of d.hashtags) expect(h).toMatch(/^#[A-Za-z0-9]+$/);
      expect(d.instagramCaption.length).toBeLessThanOrEqual(2200);
    }
  });

  it("varies the hook by audience", () => {
    const s = subject();
    const hooks = (["everyday", "college", "work", "gifting"] as const).map((a) => generateContent(s, { audience: a }).story[0].text);
    expect(new Set(hooks).size).toBe(4);
  });

  it("keeps the rendered preview within the editable limit", () => {
    for (const s of allSubjects()) expect(renderDraft(generateContent(s)).length).toBeLessThan(MAX_PREVIEW_LENGTH);
  });

  it("marks sample drafts so they are not mistaken for real content", () => {
    const d = generateContent(subjectFromProduct(contentProducts[0]));
    expect(d.issues.some((i) => i.code === "sample_data")).toBe(true);
    expect(renderDraft(d)).toContain("SAMPLE DATA");
  });

  it("only mentions packaging when the pack record sets it", () => {
    const boxed = generateContent(subjectFromPack(contentPacks[0], contentProducts)).instagramCaption;
    const plain = generateContent(subjectFromPack(contentPacks[2], contentProducts)).instagramCaption;
    expect(boxed).toContain("paper box");
    expect(plain).not.toMatch(/paper box|packed|packaging/i);
  });
});

describe("marketplace CTAs use supplied links only", () => {
  it("includes supplied links verbatim", () => {
    const d = generateContent(subject({ links: { amazon: AMAZON, flipkart: FLIPKART } }));
    expect(d.instagramCaption).toContain(`Shop on Amazon: ${AMAZON}`);
    expect(d.instagramCaption).toContain(`Shop on Flipkart: ${FLIPKART}`);
    expect(d.cta.amazon.supplied && d.cta.flipkart.supplied).toBe(true);
    expect(d.issues.some((i) => i.code === "missing_marketplace_link")).toBe(false);
  });

  it("uses a visible placeholder and a warning when a link is missing, and never invents a URL", () => {
    const d = generateContent(subject({ links: { amazon: AMAZON } }));
    expect(d.instagramCaption).toContain("[Flipkart link not supplied]");
    expect(d.issues.filter((i) => i.code === "missing_marketplace_link")).toHaveLength(1);
    const none = generateContent(subject());
    expect(copyText(none)).not.toMatch(/https?:\/\//);
    expect(none.reelScript.scenes.at(-1)?.onScreenText).toMatch(/Add a marketplace link/);
  });

  it("blocks drafts with an invalid link and does not print it", () => {
    for (const bad of ["http://www.amazon.in/dp/X", "https://evil.example/amazon.in", "javascript:alert(1)", "https://user:pw@www.amazon.in/dp/X", "not a url"]) {
      const d = generateContent(subject({ links: { amazon: bad } }));
      expect(d.blocked).toBe(true);
      expect(d.issues.some((i) => i.code === "invalid_marketplace_link")).toBe(true);
      expect(d.instagramCaption).not.toContain(bad);
    }
  });

  it("checks link hosts per marketplace", () => {
    expect(checkMarketplaceLink("amazon", "https://amzn.to/abc").ok).toBe(true);
    expect(checkMarketplaceLink("flipkart", "https://dl.flipkart.com/s/abc").ok).toBe(true);
    expect(checkMarketplaceLink("amazon", FLIPKART).ok).toBe(false);
    expect(checkMarketplaceLink("flipkart", AMAZON).ok).toBe(false);
    expect(checkMarketplaceLink("amazon", "https://www.amazon.in.evil.example/x").ok).toBe(false);
  });

  it("lets run-time links override the record and rejects bad request bodies", () => {
    const res = runContentAgent({ target: { type: "product", id: "SAMPLE-P-001" }, audience: "everyday", links: { amazon: AMAZON } }, contentProducts, contentPacks);
    expect(res.ok && res.draft.instagramCaption).toContain(AMAZON);
    expect(parseRunInput({ targetType: "product", targetId: "SAMPLE-P-001", amazonUrl: AMAZON })).toMatchObject({ ok: true });
    expect(parseRunInput({ targetType: "nope", targetId: "x" }).ok).toBe(false);
    expect(parseRunInput({ targetType: "pack", targetId: "x", audience: "everybody" }).ok).toBe(false);
    expect(parseRunInput(null).ok).toBe(false);
  });
});

describe("no invented prices, discounts, stock, materials or claims", () => {
  it("passes the claim guard for every sample record and audience", () => {
    for (const s of allSubjects()) {
      for (const a of ["everyday", "college", "work", "gifting"] as const) {
        const d = generateContent(s, { audience: a });
        expect(findProhibitedClaims(copyText(d), s.approvedClaims)).toEqual([]);
      }
    }
  });

  it("says nothing about materials when none are supplied", () => {
    for (const s of allSubjects()) {
      const text = copyText(generateContent(s));
      expect(text).not.toMatch(/\b(gold|silver|diamond|zirconia|brass|steel|plated|alloy|copper|pearl|stone|crystal)\b/i);
    }
  });

  it("states a supplied material verbatim and notes when it is missing", () => {
    const withMaterial = generateContent(subject({ materialNote: "Brass base with cubic zirconia stones" }));
    expect(withMaterial.instagramCaption).toContain("Material: Brass base with cubic zirconia stones");
    expect(generateContent(subject()).issues.some((i) => i.code === "missing_material")).toBe(true);
  });

  it("never includes numbers with currency symbols", () => {
    for (const s of allSubjects()) expect(copyText(generateContent(s))).not.toMatch(/[₹$]\s?\d|\brs\.?\s?\d/i);
  });
});

describe("prohibited claims", () => {
  it.each([
    ["price", "Only ₹499 today"], ["price", "starting at Rs. 299"], ["discount", "Flat 20% off"], ["discount", "Free shipping on all orders"],
    ["discount", "Use this coupon"], ["stock", "Only 3 left"], ["stock", "Selling fast, hurry"], ["material", "Fully waterproof"],
    ["material", "Anti-tarnish finish"], ["material", "Hypoallergenic and nickel-free"], ["precious", "Real gold look"], ["precious", "Genuine silver"],
    ["precious", "925 silver"], ["precious", "18k gold plated"], ["certification", "Hallmarked"], ["superlative", "Best price guaranteed"],
    ["superlative", "Our best-seller"], ["medical", "Heals skin irritation"],
  ])("flags %s wording: %s", (rule, text) => {
    expect(findProhibitedClaims(text).some((v) => v.rule === rule)).toBe(true);
  });

  it("allows ordinary brand wording", () => {
    expect(findProhibitedClaims("Meet the Hoop Earrings. Style: minimal · everyday. Korean-inspired minimal jewellery by Cheri & Co.")).toEqual([]);
  });

  it("lets a client-approved claim through, but only for approvable categories", () => {
    expect(findProhibitedClaims("Anti-tarnish coating", ["Anti-tarnish coating"])).toEqual([]);
    expect(findProhibitedClaims("Anti-tarnish coating", ["Water-resistant"]).length).toBe(1);
    expect(findProhibitedClaims("Only ₹499", ["Only ₹499"]).length).toBe(1);
    expect(findProhibitedClaims("Flat 20% off", ["Flat 20% off"]).length).toBe(1);
    expect(findProhibitedClaims("Only 3 left", ["Only 3 left"]).length).toBe(1);
  });

  it("blocks a draft whose supplied name carries an unapproved claim", () => {
    const d = generateContent(subject({ name: "Waterproof Anklet" }));
    expect(d.blocked).toBe(true);
    expect(d.issues.some((i) => i.code === "prohibited_claim")).toBe(true);
  });

  it("uses approved claims verbatim and keeps the draft unblocked", () => {
    const d = generateContent(subject({ approvedClaims: ["Anti-tarnish coating"] }));
    expect(d.instagramCaption).toContain("• Anti-tarnish coating");
    expect(d.blocked).toBe(false);
  });

  it("blocks approved claims that contain a price or discount", () => {
    expect(generateContent(subject({ approvedClaims: ["Now ₹499"] })).blocked).toBe(true);
    expect(generateContent(subject({ approvedClaims: ["20% off this week"] })).blocked).toBe(true);
  });
});

describe("missing product information", () => {
  it("generates generic copy and warns when category and style are missing", () => {
    const d = generateContent(subject({ categories: [], memberCategories: [], styleTags: [] }));
    expect(d.blocked).toBe(false);
    expect(d.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["missing_category", "missing_style"]));
    expect(d.instagramCaption).not.toMatch(/^Style:/m);
    expect(d.hashtags).toEqual(expect.arrayContaining(["#CheriAndCo"]));
  });

  it("blocks a record with no name", () => {
    const d = generateContent(subject({ name: "   " }));
    expect(d.blocked).toBe(true);
    expect(d.issues.some((i) => i.code === "empty_name")).toBe(true);
  });

  it("reports what was and was not supplied", () => {
    const facts = generateContent(subject()).factsUsed.join(" | ");
    expect(facts).toContain("Material: not supplied");
    expect(facts).toContain("Amazon link: not supplied");
    expect(facts).toContain("Packaging: not specified");
  });
});

describe("approval workflow", () => {
  const input = (id = "SAMPLE-P-001") => ({ target: { type: "product" as const, id }, audience: "everyday" as const, links: {} });
  beforeEach(() => { store.approvals.length = 0; store.audit.length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it("allows only AI generated → pending review → approved or rejected", () => {
    expect(canTransition("ai_generated", "pending_review")).toBe(true);
    expect(canTransition("ai_generated", "approved")).toBe(false);
    expect(canTransition("pending_review", "approved")).toBe(true);
    expect(canTransition("pending_review", "rejected")).toBe(true);
    for (const done of ["approved", "rejected"] as const)
      for (const next of ["ai_generated", "pending_review", "approved", "rejected"] as const) expect(canTransition(done, next)).toBe(false);
  });

  it("maps stored statuses onto the workflow", () => {
    expect(workflowStatus("pending")).toBe("pending_review");
    expect(workflowStatus("approved")).toBe("approved");
    expect(workflowStatus("rejected")).toBe("rejected");
  });

  it("starts a generated draft as AI generated and not published", () => {
    const run = runContentAgent(input(), contentProducts, contentPacks);
    expect(run.ok && run.draft.status).toBe("ai_generated");
    expect(run.ok && run.draft.published).toBe(false);
  });

  it("queues a submitted draft as pending review", async () => {
    const res = await submitContentDraft(input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.approval).toMatchObject({ status: "pending", type: "Content", generatedBy: "content", meta: { kind: "content_draft", isSample: true } });
    expect((await getApprovals())[0].id).toBe(res.approval.id);
  });

  it("refuses blocked drafts, unknown targets and duplicates", async () => {
    const blocked = await submitContentDraft({ ...input(), links: { amazon: "http://www.amazon.in/x" } });
    expect(blocked).toMatchObject({ ok: false, reason: "blocked" });
    expect(await submitContentDraft(input("nope"))).toMatchObject({ ok: false, reason: "invalid" });
    expect((await submitContentDraft(input())).ok).toBe(true);
    expect(await submitContentDraft(input())).toMatchObject({ ok: false, reason: "duplicate" });
    expect(store.approvals).toHaveLength(1);
  });

  it("approves without executing or publishing, and writes one audit entry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sub = await submitContentDraft(input());
    if (!sub.ok) throw new Error("submit failed");
    const res = await decideApproval(sub.approval.id, "approve", "tester");
    expect(res).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(res.ok && res.approval.status).not.toBe("executed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.audit).toHaveLength(1);
  });

  it("rejects a draft and records it", async () => {
    const sub = await submitContentDraft(input());
    if (!sub.ok) throw new Error("submit failed");
    expect(await decideApproval(sub.approval.id, "reject", "tester", "off brand")).toMatchObject({ ok: true, approval: { status: "rejected" } });
    expect(store.audit[0]).toMatchObject({ action: "reject", note: "off brand" });
  });

  it("cannot decide or edit an item twice, and failed attempts write no audit entry", async () => {
    const sub = await submitContentDraft(input());
    if (!sub.ok) throw new Error("submit failed");
    await decideApproval(sub.approval.id, "approve", "tester");
    for (const action of ["approve", "reject", "edit"] as const)
      expect(await decideApproval(sub.approval.id, action, "tester", undefined, { title: "x" })).toMatchObject({ ok: false, reason: "not_pending" });
    expect(store.audit).toHaveLength(1);
    expect(await decideApproval("missing", "approve", "tester")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("will not approve an edited draft that contains prohibited wording", async () => {
    const sub = await submitContentDraft(input());
    if (!sub.ok) throw new Error("submit failed");
    await decideApproval(sub.approval.id, "edit", "tester", undefined, { preview: "Waterproof and only ₹499" });
    const res = await decideApproval(sub.approval.id, "approve", "tester");
    expect(res).toMatchObject({ ok: false, reason: "prohibited_claims" });
    expect(store.approvals[0].status).toBe("pending");
    expect(await decideApproval(sub.approval.id, "edit", "tester", undefined, { preview: "Clean wording only." })).toMatchObject({ ok: true });
    expect(await decideApproval(sub.approval.id, "approve", "tester")).toMatchObject({ ok: true, approval: { status: "approved" } });
  });

  it("never touches the network while generating or submitting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    generateContent(subjectFromPack(contentPacks[3], contentProducts));
    await submitContentDraft(input("SAMPLE-P-002"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Claude configuration (planned, not implemented)", () => {
  it("is off by default and still uses templates when switched on", () => {
    expect(isClaudeRequested({})).toBe(false);
    expect(isClaudeRequested({ CONTENT_AGENT_USE_CLAUDE: "false" })).toBe(false);
    expect(chooseGenerator({})).toEqual({ generator: "template", claudeRequested: false });
    const on = chooseGenerator({ CONTENT_AGENT_USE_CLAUDE: "true" });
    expect(on).toMatchObject({ generator: "template", claudeRequested: true });
    expect(on.note).toMatch(/not built yet/);
    expect(on.note).toMatch(/No Claude API call was made/);
  });

  it("ignores the removed GPT switch", () => {
    expect(isClaudeRequested({ CONTENT_AGENT_USE_GPT: "true" })).toBe(false);
    expect(chooseGenerator({ CONTENT_AGENT_USE_GPT: "true" })).toEqual({ generator: "template", claudeRequested: false });
  });

  it("never reads an API key, whichever provider it belongs to", () => {
    const env = new Proxy({ CONTENT_AGENT_USE_CLAUDE: "true" } as Record<string, string | undefined>, {
      get(target, key: string) { if (/API_KEY/.test(key)) throw new Error("key read"); return target[key]; },
    });
    expect(() => chooseGenerator(env)).not.toThrow();
  });

  it("makes no network call, with the flag on, when drafting or submitting", async () => {
    const prev = process.env.CONTENT_AGENT_USE_CLAUDE;
    process.env.CONTENT_AGENT_USE_CLAUDE = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const run = runContentAgent({ target: { type: "pack", id: "SAMPLE-PACK-001" }, audience: "everyday", links: {} }, contentProducts, contentPacks);
      expect(run).toMatchObject({ ok: true });
      if (run.ok) { expect(run.draft.generator).toBe("template"); expect(run.note).toMatch(/not built yet/); }
      await submitContentDraft({ target: { type: "product", id: "SAMPLE-P-001" }, audience: "everyday", links: {} });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      store.approvals.length = 0; store.audit.length = 0;
      if (prev === undefined) delete process.env.CONTENT_AGENT_USE_CLAUDE; else process.env.CONTENT_AGENT_USE_CLAUDE = prev;
    }
  });
});

describe("no live integrations or publishing in source", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  }
  const files = sourceFiles(join(process.cwd(), "src"));
  const text = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => f.replace(process.cwd(), ""));

  it("has no OpenAI/GPT code or key reference left", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(text(/openai|gpt-?\d|chatgpt|OPENAI_API_KEY/i)).toEqual([]);
  });

  it("has no Anthropic SDK, endpoint or key read", () => {
    expect(text(/@anthropic-ai|api\.anthropic\.com|env\.ANTHROPIC|env\[["']ANTHROPIC/)).toEqual([]);
  });

  it("has no Canva API, Instagram Graph or marketplace publishing call", () => {
    expect(text(/api\.canva\.com|graph\.facebook\.com|graph\.instagram\.com|sellingpartnerapi|mws\.amazon|flipkart\.net/i)).toEqual([]);
  });

  it("does not use fetch outside the dashboard's own routes", () => {
    const offenders = text(/fetch\(\s*["'`]https?:/i);
    expect(offenders).toEqual([]);
  });

  it("has no publish status or publish transition for content", () => {
    expect(text(/status:\s*["']published["']\s*[,}]/).filter((f) => /content-agent|services/.test(f))).toEqual([]);
    expect(canTransition("approved", "published" as never)).toBe(false);
    expect(Object.keys(WORKFLOW_LABEL).join(" ")).not.toMatch(/publish/i);
  });
});

describe("demonstration data is labelled and carries no invented claims", () => {
  const demo = JSON.stringify({ mockApprovals, brandRules });

  it("has no anti-tarnish or free gift wrap wording", () => {
    expect(demo).not.toMatch(/anti-?tarnish|gift wrap|gift box/i);
  });

  it("labels every inherited approval as SAMPLE", () => {
    for (const a of mockApprovals) expect(a.title.startsWith("SAMPLE")).toBe(true);
  });

  it("labels every inherited brand rule as not client-approved", () => {
    for (const r of brandRules) expect(r.detail).toMatch(/^SAMPLE, not client-approved\./);
  });
});
