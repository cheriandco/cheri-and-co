/** Shared AI infrastructure: configuration, redaction, the structured client, spend and rate limits, the transport. Every test uses a
 *  scripted fake transport or an injected fetch; nothing here touches the network or a database. */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL, readAiConfig, unavailableReason, type AiConfig } from "@/lib/ai/config";
import { containsPersonalData, redactDeep, redactPersonalData } from "@/lib/ai/redact";
import { callStructured } from "@/lib/ai/client";
import {
  CallRateLimiter, LEDGER_PREFIX, dayStartUtc, estimateInputTokens, formatLedgerAction, monthStartUtc, parseLedgerCost, reserveAiCall, totals, worstCaseCostUsd,
} from "@/lib/ai/limits";
import { OPENAI_BASE, createOpenAiTransport, getOpenAiTransport } from "@/lib/ai/transport";
import { GOOD_OUTPUT, MemoryLedger, fakeTransport, okBody } from "./helpers/fake-openai";

const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true, model: "test-model", maxOutputTokens: 1000, timeoutMs: 5000, monthlyBudgetUsd: 20, dailyCallsPerOrg: 100, perUserPerMinute: 5,
  priceInPerMTok: 2, priceOutPerMTok: 8, ...over,
});

describe("configuration", () => {
  it("is OFF by default and needs the exact value true", () => {
    expect(readAiConfig({}).enabled).toBe(false);
    for (const v of ["TRUE", "1", "yes", " true", "false", ""]) expect(readAiConfig({ AI_ENABLED: v }).enabled).toBe(false);
    expect(readAiConfig({ AI_ENABLED: "true" }).enabled).toBe(true);
  });

  it("uses the owner's defaults: gpt-6-sol, $20 a month, 100 calls a day", () => {
    const c = readAiConfig({});
    expect(c.model).toBe("gpt-6-sol");
    expect(DEFAULT_MODEL).toBe("gpt-6-sol");
    expect(c.monthlyBudgetUsd).toBe(20);
    expect(c.dailyCallsPerOrg).toBe(100);
  });

  it("takes the model from OPENAI_MODEL and rejects odd values", () => {
    expect(readAiConfig({ OPENAI_MODEL: "my-model-1" }).model).toBe("my-model-1");
    expect(readAiConfig({ OPENAI_MODEL: "bad model; drop" }).model).toBe(DEFAULT_MODEL);
    expect(readAiConfig({ OPENAI_MODEL: "  " }).model).toBe(DEFAULT_MODEL);
  });

  it("falls back to safe defaults for nonsense numbers", () => {
    const c = readAiConfig({ AI_MONTHLY_BUDGET_USD: "abc", AI_DAILY_CALLS_PER_ORG: "-5", AI_TIMEOUT_MS: "1", AI_MAX_OUTPUT_TOKENS: "999999", AI_CALLS_PER_USER_PER_MINUTE: "0" });
    expect([c.monthlyBudgetUsd, c.dailyCallsPerOrg, c.timeoutMs, c.maxOutputTokens, c.perUserPerMinute]).toEqual([20, 100, 30000, 1500, 5]);
  });

  it("has no default prices, so AI stays unavailable until they are set", () => {
    const c = readAiConfig({ AI_ENABLED: "true" });
    expect(c.priceInPerMTok).toBeNull();
    expect(unavailableReason(c)).toBe("pricing_not_configured");
    expect(unavailableReason(readAiConfig({}))).toBe("disabled");
    expect(readAiConfig({ OPENAI_PRICE_INPUT_USD_PER_MTOK: "0", OPENAI_PRICE_OUTPUT_USD_PER_MTOK: "-1" }).priceInPerMTok).toBeNull();
    const ok = readAiConfig({ AI_ENABLED: "true", OPENAI_PRICE_INPUT_USD_PER_MTOK: "2.5", OPENAI_PRICE_OUTPUT_USD_PER_MTOK: "10" });
    expect(unavailableReason(ok)).toBeNull();
  });

  it("never exposes the API key", () => {
    const c = readAiConfig({ AI_ENABLED: "true", OPENAI_API_KEY: "sk-secret-value-123" });
    expect(JSON.stringify(c)).not.toContain("sk-secret");
  });
});

describe("personal-data redaction", () => {
  it("replaces emails, phone numbers, links and handles", () => {
    const r = redactPersonalData("Mail anika@example.com or call +91 98765 43210, see https://x.example/p and @anika_style");
    expect(r.text).toBe("Mail [email] or call [number], see [link] and [handle]");
    expect(r.count).toBe(4);
  });

  it("leaves ordinary product text alone", () => {
    for (const s of ["Pearl hoop earrings", "2 × earrings, 1 × ring", "Pack of 6 pieces", "Style: minimal · everyday", "SKU 1234"]) {
      expect(redactPersonalData(s)).toEqual({ text: s, count: 0 });
    }
  });

  it("redacts long digit runs such as phone and id numbers", () => {
    expect(redactPersonalData("Order 123456789012").text).toBe("Order [number]");
    expect(redactPersonalData("(022) 2345-6789").text).toBe("[number]");
  });

  it("redacts every string inside nested data and counts the changes", () => {
    const { value, count } = redactDeep({ a: "x@y.com", b: ["call 9876543210", { c: "fine" }], n: 5 });
    expect(value).toEqual({ a: "[email]", b: ["call [number]", { c: "fine" }], n: 5 });
    expect(count).toBe(2);
  });

  it("detects personal data in model output", () => {
    expect(containsPersonalData("reach me at a@b.co")).toBe(true);
    expect(containsPersonalData("A quiet little ring")).toBe(false);
  });
});

describe("structured client", () => {
  const base = (t: ReturnType<typeof fakeTransport>) => ({
    transport: t.transport, config: cfg(), instructions: "ins", input: "{}", schemaName: "s", schema: { type: "object" },
    validate: (raw: unknown) => (raw && typeof raw === "object" && "caption" in raw ? (raw as { caption: string }) : null),
  });

  it("sends the documented Responses API request with store off, strict JSON schema and no tools", async () => {
    const t = fakeTransport(okBody(GOOD_OUTPUT));
    const r = await callStructured(base(t));
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(1);
    const req = t.calls[0];
    expect(req.path).toBe("/v1/responses");
    expect(req.body).toMatchObject({ model: "test-model", instructions: "ins", input: "{}", max_output_tokens: 1000, store: false });
    expect(req.body.text).toMatchObject({ format: { type: "json_schema", name: "s", strict: true } });
    expect(req.body).not.toHaveProperty("tools");
  });

  it("returns usage and the model", async () => {
    const r = await callStructured(base(fakeTransport(okBody(GOOD_OUTPUT, { input_tokens: 11, output_tokens: 22 }))));
    expect(r).toMatchObject({ ok: true, usage: { inputTokens: 11, outputTokens: 22 }, model: "test-model" });
  });

  it("maps failures to codes without retrying", async () => {
    const cases: [ReturnType<typeof fakeTransport>, string][] = [
      [fakeTransport({ status: 500, body: null }), "http_error"],
      [fakeTransport({ status: 429, body: { error: "x" } }), "http_error"],
      [fakeTransport(new Error("boom")), "network"],
      [fakeTransport({ status: 200, body: { status: "incomplete", output: [] } }), "incomplete"],
      [fakeTransport({ status: 200, body: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] } }), "refused"],
      [fakeTransport({ status: 200, body: { status: "completed", output: [] } }), "bad_output"],
      [fakeTransport({ status: 200, body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] } }), "bad_output"],
      [fakeTransport(okBody({ other: 1 })), "invalid_output"],
    ];
    for (const [t, code] of cases) {
      const r = await callStructured(base(t));
      expect(r).toMatchObject({ ok: false, code });
      expect(t.calls).toHaveLength(1);
    }
  });

  it("times out and aborts the request", async () => {
    const t = fakeTransport((req) => new Promise((_res, rej) => { req.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); }));
    const r = await callStructured({ ...base(t), config: cfg({ timeoutMs: 20 }) });
    expect(r).toMatchObject({ ok: false, code: "timeout" });
  });

  it("never puts provider text or the status body into the result", async () => {
    const r = await callStructured(base(fakeTransport({ status: 401, body: { error: { message: "Incorrect API key sk-live-XXXX" } } })));
    expect(JSON.stringify(r)).not.toContain("sk-live");
  });
});

describe("limits", () => {
  const NOW = new Date("2026-11-17T10:00:00Z");
  const args = (ledger: MemoryLedger, over: Partial<Parameters<typeof reserveAiCall>[0]> = {}) => ({
    ledger, config: cfg(), limiter: new CallRateLimiter(100), userKey: "u1", agent: "content" as const, inputChars: 3000, now: NOW, ...over,
  });

  it("estimates a conservative worst-case cost from prices and the output allowance", () => {
    expect(estimateInputTokens(3000)).toBe(1000);
    expect(worstCaseCostUsd(3000, cfg())).toBeCloseTo((1000 * 2 + 1000 * 8) / 1e6, 10);
    expect(worstCaseCostUsd(3000, cfg({ priceInPerMTok: null }))).toBeNull();
  });

  it("writes a ledger row BEFORE allowing the call and parses its cost back", async () => {
    const ledger = new MemoryLedger();
    const r = await reserveAiCall(args(ledger));
    expect(r.ok).toBe(true);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].action.startsWith(LEDGER_PREFIX)).toBe(true);
    expect(parseLedgerCost(ledger.rows[0].action)).toBeCloseTo(0.01, 6);
    expect(ledger.rows[0].agent).toBe("content");
  });

  it("stops at the daily limit of calls per organisation", async () => {
    const ledger = new MemoryLedger();
    const c = cfg({ dailyCallsPerOrg: 3 });
    for (let i = 0; i < 3; i++) expect((await reserveAiCall(args(ledger, { config: c }))).ok).toBe(true);
    expect(await reserveAiCall(args(ledger, { config: c }))).toEqual({ ok: false, reason: "daily_cap" });
    expect(ledger.rows).toHaveLength(3); // the refused attempt wrote nothing
  });

  it("does not count yesterday's calls toward today's limit, but does count them toward the month", async () => {
    const ledger = new MemoryLedger();
    ledger.rows.push({ action: formatLedgerAction("content", "m", 19.995), at: "2026-11-16T09:00:00.000Z", agent: "content" });
    expect(totals(await ledger.usage(monthStartUtc(NOW).toISOString()), NOW)).toEqual({ callsToday: 0, spentMonthUsd: 19.995 });
    // 19.995 already spent + 0.01 estimated > $20 monthly budget
    expect(await reserveAiCall(args(ledger))).toEqual({ ok: false, reason: "monthly_cap" });
  });

  it("ignores ledger rows from a previous month", async () => {
    const ledger = new MemoryLedger();
    ledger.rows.push({ action: formatLedgerAction("content", "m", 50), at: "2026-10-31T23:59:00.000Z", agent: "content" });
    expect((await reserveAiCall(args(ledger))).ok).toBe(true);
  });

  it("enforces the monthly budget of $20 using the reserved estimates", async () => {
    const ledger = new MemoryLedger();
    const c = cfg({ priceInPerMTok: 1000, priceOutPerMTok: 4000, maxOutputTokens: 1000 }); // about $4.3 per call
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await reserveAiCall(args(ledger, { config: c }))).ok) allowed++;
    expect(allowed).toBe(4);
    expect(totals(await ledger.usage(monthStartUtc(NOW).toISOString()), NOW).spentMonthUsd).toBeLessThanOrEqual(20);
  });

  it("refuses when pricing is not configured", async () => {
    expect(await reserveAiCall(args(new MemoryLedger(), { config: cfg({ priceOutPerMTok: null }) }))).toEqual({ ok: false, reason: "pricing_not_configured" });
  });

  it("fails closed when the ledger cannot be read or written", async () => {
    const a = new MemoryLedger(); a.failReads = true;
    expect(await reserveAiCall(args(a))).toEqual({ ok: false, reason: "ledger_unavailable" });
    const b = new MemoryLedger(); b.failWrites = true;
    expect(await reserveAiCall(args(b))).toEqual({ ok: false, reason: "ledger_unavailable" });
  });

  it("catches a concurrent overshoot by re-counting after the reservation", async () => {
    const ledger = new MemoryLedger();
    const c = cfg({ dailyCallsPerOrg: 1 });
    // two requests both read an empty ledger before either writes
    const original = ledger.usage.bind(ledger);
    let firstReads = 0;
    ledger.usage = async (s) => (firstReads++ < 2 ? [] : original(s));
    const results = await Promise.all([reserveAiCall(args(ledger, { config: c, userKey: "a" })), reserveAiCall(args(ledger, { config: c, userKey: "b" }))]);
    // never more than the cap; when both race, both are refused (the safe direction) and the reservations are not refunded
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    expect(ledger.rows).toHaveLength(2);
  });

  it("limits calls per user per minute and lets the window pass", () => {
    const l = new CallRateLimiter(2, 60_000);
    expect([l.allow("u", 0), l.allow("u", 1000), l.allow("u", 2000)]).toEqual([true, true, false]);
    expect(l.allow("other", 2000)).toBe(true);
    expect(l.allow("u", 61_001)).toBe(true);
  });

  it("day and month windows are UTC", () => {
    expect(dayStartUtc(NOW).toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(monthStartUtc(NOW).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("transport", () => {
  it("is null without a key, so the template is used", () => {
    expect(getOpenAiTransport({})).toBeNull();
    expect(getOpenAiTransport({ OPENAI_API_KEY: "   " })).toBeNull();
    expect(getOpenAiTransport({ OPENAI_API_KEY: "sk-test" })).not.toBeNull();
  });

  it("posts JSON to the Responses endpoint with a bearer key and no cookies", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const t = createOpenAiTransport("sk-test-key", fetchImpl as unknown as typeof fetch);
    const res = await t({ path: "/v1/responses", body: { a: 1 }, signal: new AbortController().signal });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OPENAI_BASE}/v1/responses`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key");
    expect(init.body).toBe('{"a":1}');
    expect(init.cache).toBe("no-store");
  });

  it("returns a null body for a non-JSON error page", async () => {
    const t = createOpenAiTransport("sk-x", (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch);
    expect(await t({ path: "/v1/responses", body: {}, signal: new AbortController().signal })).toEqual({ status: 502, body: null });
  });
});

describe("source guards", () => {
  it("the AI library has no secrets and does not log", () => {
    for (const f of ["config", "redact", "client", "limits", "transport"]) {
      const src = readFileSync(`src/lib/ai/${f}.ts`, "utf8");
      expect(src, f).not.toMatch(/console\.|sk-[A-Za-z0-9]{10,}/);
    }
  });

  it("only transport.ts reads the key", () => {
    for (const f of ["config", "redact", "client", "limits"]) expect(readFileSync(`src/lib/ai/${f}.ts`, "utf8"), f).not.toMatch(/OPENAI_API_KEY|process\.env\.OPENAI/);
  });
});
