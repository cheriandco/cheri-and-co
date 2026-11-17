import { describe, expect, it } from "vitest";
import {
  ASSUMED_PRICE_USD_PER_1000, FieldMaskError, InMemoryBudgetGate, MemoryUsageSink, PlacesClient, PlacesError, TokenBucket, buildFieldMask, buildTextQuery,
  describePlacesProblem, estimateRun, isAllowedField, loadPlacesConfig, mapDetailsResponse, mapPlace, mapSearchResponse, safeStatusCode, type BudgetGate, type PlacesClientOptions, type UsageSink,
} from "@/lib/prospecting/places";
import { FakePlacesTransport, err, ok, wirePlace, type Step } from "./helpers/fake-places-transport";
import { FETCHED, SENTINEL } from "./helpers/places-fixtures";

const sleeps: number[] = [];
function make(script: Step[], o: Partial<PlacesClientOptions> = {}) {
  const transport = new FakePlacesTransport(script);
  const budget = (o.budget ?? new InMemoryBudgetGate({ maxRequests: 100 })) as InMemoryBudgetGate;
  const usage = new MemoryUsageSink();
  sleeps.length = 0;
  const client = new PlacesClient({ transport, budget, usage, enabled: true, timeoutMs: 50, maxRetries: 2, maxWaitMs: 2000, now: () => 1_000_000, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, ...o });
  return { transport, budget, usage, client };
}
const Q = { textQuery: "fashion jewellery in Indore" };
const expectKind = async (p: Promise<unknown>, kind: string) => { const e = await p.then(() => undefined, (x: unknown) => x); expect(e).toBeInstanceOf(PlacesError); expect((e as PlacesError).kind).toBe(kind); return e as PlacesError; };

describe("field masks", () => {
  it("builds the exact search and details headers", () => {
    expect(buildFieldMask("search").header).toBe("places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.types,places.primaryType,places.businessStatus,nextPageToken");
    expect(buildFieldMask("details").header).toBe("id,websiteUri,nationalPhoneNumber,rating,userRatingCount");
  });
  it("always includes id once, and accepts a subset", () => {
    expect(buildFieldMask("search", ["displayName", "id", "displayName"]).header).toBe("places.id,places.displayName,nextPageToken");
    expect(buildFieldMask("details", ["rating"]).fields).toEqual(["id", "rating"]);
  });
  it("refuses any field outside the whitelist (reviews, photos, hours, editorial text, injected separators)", () => {
    for (const bad of ["reviews", "photos", "regularOpeningHours", "editorialSummary", "places.id,reviews", "*", ""]) expect(() => buildFieldMask("search", [bad])).toThrow(FieldMaskError);
    expect(() => buildFieldMask("search", ["websiteUri"])).toThrow(FieldMaskError);   // a details field is not allowed in a search mask
    expect(() => buildFieldMask("details", ["displayName"])).toThrow(FieldMaskError);
    expect(isAllowedField("details", "websiteUri")).toBe(true);
    expect(isAllowedField("search", "websiteUri")).toBe(false);
  });
  it("reports the highest tier in the mask (unverified table)", () => {
    expect(buildFieldMask("search").tier).toBe("pro");
    expect(buildFieldMask("search", ["id"]).tier).toBe("ids_only");
    expect(buildFieldMask("details").tier).toBe("enterprise");
  });
});

describe("response mappers (whitelist, partial data, no guessing)", () => {
  it("maps a full place", () => {
    const p = mapPlace(wirePlace("test-place-1", { nationalPhoneNumber: "0731 2345678", websiteUri: "https://x.example", rating: 4.5, userRatingCount: 12 }), FETCHED)!;
    expect(p).toMatchObject({ placeId: "test-place-1", displayName: "Test Shop test-place-1", primaryType: "jewelry_store", businessStatus: "OPERATIONAL", rating: 4.5, userRatingCount: 12, fetchedAt: FETCHED });
    expect(p.addressComponents?.[0]).toEqual({ longText: "Indore", shortText: "Indore", types: ["locality"] });
    expect(p.location).toEqual({ latitude: 22.7, longitude: 75.8 });
  });
  it("leaves missing fields unknown instead of inventing them", () => {
    const p = mapPlace({ id: "test-place-2" }, FETCHED)!;
    expect(p).toMatchObject({ placeId: "test-place-2", types: [], fetchedAt: FETCHED });
    for (const k of ["displayName", "formattedAddress", "addressComponents", "location", "primaryType", "businessStatus", "nationalPhoneNumber", "websiteUri", "rating", "userRatingCount"]) expect((p as unknown as Record<string, unknown>)[k]).toBeUndefined();
  });
  it("drops fields that are not on the whitelist (reviews, photos, anything else)", () => {
    const p = mapPlace(wirePlace("test-place-3", { reviews: [{ text: SENTINEL }], photos: [{ name: SENTINEL }], regularOpeningHours: { x: 1 }, internationalPhoneNumber: SENTINEL, editorialSummary: { text: SENTINEL } }), FETCHED)!;
    expect(JSON.stringify(p)).not.toContain(SENTINEL);
    expect(Object.keys(p).sort()).toEqual(["addressComponents", "businessStatus", "displayName", "fetchedAt", "formattedAddress", "location", "placeId", "primaryType", "types", "nationalPhoneNumber", "rating", "userRatingCount", "websiteUri"].sort());
  });
  it("rejects malformed values field by field", () => {
    const p = mapPlace({ id: "test-place-4", businessStatus: "WEIRD", rating: 9, userRatingCount: -1, location: { latitude: 200, longitude: 5 }, types: ["a", 5, null], displayName: 42, addressComponents: [{ types: "x" }, null, { types: [] }] }, FETCHED)!;
    expect(p.businessStatus).toBeUndefined();
    expect(p.rating).toBeUndefined();
    expect(p.userRatingCount).toBeUndefined();
    expect(p.location).toBeUndefined();
    expect(p.types).toEqual(["a"]);
    expect(p.displayName).toBeUndefined();
    expect(p.addressComponents).toBeUndefined();
  });
  it("accepts a bare-string display name and caps long text", () => {
    expect(mapPlace({ id: "test-place-5", displayName: "Plain" }, FETCHED)?.displayName).toBe("Plain");
    expect(mapPlace({ id: "test-place-5", displayName: { text: "x".repeat(9999) } }, FETCHED)?.displayName?.length).toBe(500);
  });
  it("refuses entries without a valid Place ID", () => {
    for (const bad of [{}, { id: "" }, { id: 5 }, { id: "a b" }, { id: "x" }, null, "s", []]) expect(mapPlace(bad, FETCHED)).toBeUndefined();
  });
  it("search body: counts dropped entries, keeps the page token, treats an omitted places list as empty", () => {
    const m = mapSearchResponse({ places: [wirePlace("test-p-1"), { nope: 1 }, wirePlace("test-p-2")], nextPageToken: "tok-1" }, FETCHED)!;
    expect(m.places.map((p) => p.placeId)).toEqual(["test-p-1", "test-p-2"]);
    expect(m).toMatchObject({ dropped: 1, nextPageToken: "tok-1" });
    expect(mapSearchResponse({}, FETCHED)).toEqual({ places: [], nextPageToken: undefined, dropped: 0 });
    expect(mapSearchResponse({ places: "x" }, FETCHED)).toBeUndefined();
    expect(mapSearchResponse(null, FETCHED)).toBeUndefined();
    expect(mapSearchResponse({ nextPageToken: "x".repeat(5000) }, FETCHED)?.nextPageToken).toBeUndefined();
  });
  it("details body must be a place", () => {
    expect(mapDetailsResponse(wirePlace("test-d-1"), FETCHED)?.placeId).toBe("test-d-1");
    expect(mapDetailsResponse([], FETCHED)).toBeUndefined();
  });
});

describe("kill switch, demo organisations, stop-all and budget refuse BEFORE any call", () => {
  it("is off by default: nothing reaches the transport or the budget", async () => {
    const { client, transport, budget } = make([ok({})], { enabled: false });
    await expectKind(client.searchPage(Q), "disabled");
    await expectKind(client.details("test-place-0001"), "disabled");
    expect(transport.calls).toBe(0);
    expect(budget.requestsUsed).toBe(0);
  });
  it("demonstration organisations never call Google, even when enabled", async () => {
    const { client, transport } = make([ok({})], { demo: true });
    await expectKind(client.searchPage(Q), "demo");
    expect(transport.calls).toBe(0);
  });
  it("stop-all blocks every attempt, including a retry", async () => {
    let stopped = false;
    const { client, transport } = make([err(500), ok({})], { isStopped: () => stopped });
    const run = client.searchPage(Q);
    stopped = true;
    await expectKind(run, "stopped");
    expect(transport.calls).toBeLessThanOrEqual(1);
    const second = make([ok({})], { isStopped: async () => true });
    await expectKind(second.client.searchPage(Q), "stopped");
    expect(second.transport.calls).toBe(0);
  });
  it("loadPlacesConfig turns the switch on only for the exact text true", () => {
    expect(loadPlacesConfig({})).toEqual({ enabled: false });
    for (const v of ["TRUE", "1", "yes", "", " true"]) expect(loadPlacesConfig({ GOOGLE_PLACES_ENABLED: v }).enabled).toBe(false);
    expect(loadPlacesConfig({ GOOGLE_PLACES_ENABLED: "true" }).enabled).toBe(true);
  });
  it("a refused reservation means no call and a budget error", async () => {
    const { client, transport } = make([ok({}), ok({})], { budget: new InMemoryBudgetGate({ maxRequests: 0 }) });
    await expectKind(client.searchPage(Q), "budget");
    expect(transport.calls).toBe(0);
  });
  it("a stopped gate is reported as stopped", async () => {
    const gate = new InMemoryBudgetGate({ maxRequests: 5 }); gate.stop();
    await expectKind(make([ok({})], { budget: gate }).client.searchPage(Q), "stopped");
  });
  it("the gate enforces the request cap and the cost cap, and counts each attempt", async () => {
    const { client, budget, transport } = make([ok({}), ok({}), ok({})], { budget: new InMemoryBudgetGate({ maxRequests: 2 }) });
    await client.searchPage(Q); await client.searchPage(Q);
    await expectKind(client.searchPage(Q), "budget");
    expect(transport.calls).toBe(2);
    expect((budget as InMemoryBudgetGate).requestsUsed).toBe(2);
    const g = new InMemoryBudgetGate({ maxRequests: 100, maxCostUsd: 0.05 });
    const t = make([ok({}), ok({})], { budget: g });
    await t.client.searchPage(Q);                       // 0.035
    await expectKind(t.client.searchPage(Q), "budget"); // would reach 0.070
  });
  it("concurrent callers can never exceed a cap (exactly three of five succeed)", async () => {
    const { client, transport } = make([ok({}), ok({}), ok({}), ok({}), ok({})], { budget: new InMemoryBudgetGate({ maxRequests: 3 }), rate: { rate: 1000, burst: 1000 } });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => client.searchPage(Q)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(transport.calls).toBe(3);
  });
});

describe("search and pagination", () => {
  it("sends a well-formed Text Search request", async () => {
    const { client, transport } = make([ok({ places: [wirePlace("test-s-1")] })]);
    const page = await client.searchPage({ ...Q, pageSize: 99 });
    expect(page.places[0].placeId).toBe("test-s-1");
    expect(transport.requests[0]).toMatchObject({ operation: "searchText", method: "POST", path: "/v1/places:searchText", body: { textQuery: Q.textQuery, pageSize: 20, regionCode: "IN" } });
    expect(transport.requests[0].fieldMask).toContain("nextPageToken");
    expect(transport.requests[0].fieldMask).not.toContain("websiteUri");
  });
  it("validates the query before spending anything", async () => {
    const { client, transport, budget } = make([ok({})]);
    for (const q of [{ textQuery: "  " }, { textQuery: "x".repeat(301) }, { ...Q, regionCode: "india" }, { ...Q, pageToken: "" }]) await expectKind(client.searchPage(q), "bad_request");
    expect(transport.calls).toBe(0);
    expect(budget.requestsUsed).toBe(0);
  });
  it("clamps the page size to 1..20 and passes language and token", async () => {
    const { client, transport } = make([ok({}), ok({})]);
    await client.searchPage({ ...Q, pageSize: 0, languageCode: "en", pageToken: "tok" });
    expect(transport.requests[0].body).toMatchObject({ pageSize: 1, languageCode: "en", pageToken: "tok" });
  });
  it("follows page tokens, merges pages and de-duplicates Place IDs", async () => {
    const { client, transport } = make([
      ok({ places: [wirePlace("test-a-1"), wirePlace("test-a-2")], nextPageToken: "t1" }),
      ok({ places: [wirePlace("test-a-2"), wirePlace("test-a-3")], nextPageToken: "t2" }),
      ok({ places: [wirePlace("test-a-4")] }),
    ]);
    const r = await client.searchAll(Q, { maxPages: 5 });
    expect(r.places.map((p) => p.placeId)).toEqual(["test-a-1", "test-a-2", "test-a-3", "test-a-4"]);
    expect(r).toMatchObject({ pages: 3, repeated: 1, nextPageToken: undefined });
    expect(transport.requests.map((x) => x.body?.pageToken)).toEqual([undefined, "t1", "t2"]);
    expect(transport.requests.every((x) => x.body?.textQuery === Q.textQuery)).toBe(true);
  });
  it("stops at the page cap and returns the token to resume from", async () => {
    const { client, transport } = make([ok({ places: [wirePlace("test-b-1")], nextPageToken: "t1" }), ok({ places: [wirePlace("test-b-2")], nextPageToken: "t2" })]);
    const r = await client.searchAll(Q, { maxPages: 2, betweenPagesMs: 700 });
    expect(r).toMatchObject({ pages: 2, nextPageToken: "t2" });
    expect(transport.calls).toBe(2);
    expect(sleeps).toContain(700);
  });
  it("resumes from a saved token", async () => {
    const { client, transport } = make([ok({ places: [wirePlace("test-c-1")] })]);
    await client.searchAll({ ...Q, pageToken: "saved" });
    expect(transport.requests[0].body?.pageToken).toBe("saved");
  });
  it("keeps the places already collected when a later page fails", async () => {
    const { client } = make([ok({ places: [wirePlace("test-d-1")], nextPageToken: "t1" }), err(403, { error: { status: "PERMISSION_DENIED", message: SENTINEL } })]);
    const r = await client.searchAll(Q);
    expect(r.places).toHaveLength(1);
    expect(r.stoppedBy?.kind).toBe("forbidden");
    expect(r.nextPageToken).toBe("t1");
  });
  it("a first-page failure is thrown", async () => {
    await expectKind(make([err(400)]).client.searchAll(Q), "bad_request");
  });
  it("counts entries it had to drop", async () => {
    const r = await make([ok({ places: [wirePlace("test-e-1"), { id: "" }, 7] })]).client.searchAll(Q);
    expect(r).toMatchObject({ dropped: 2 });
  });
  it("an empty result is a normal answer", async () => {
    const r = await make([ok({})]).client.searchAll(Q);
    expect(r).toMatchObject({ places: [], pages: 1 });
  });
});

describe("place details", () => {
  it("requests a narrow mask and returns the place", async () => {
    const { client, transport } = make([ok({ id: "test-det-0001", nationalPhoneNumber: "0731 2345678", websiteUri: "https://x.example", rating: 4, userRatingCount: 3 })]);
    const p = await client.details("test-det-0001");
    expect(p).toMatchObject({ placeId: "test-det-0001", nationalPhoneNumber: "0731 2345678", userRatingCount: 3 });
    expect(transport.requests[0]).toMatchObject({ operation: "placeDetails", method: "GET", path: "/v1/places/test-det-0001", fieldMask: "id,websiteUri,nationalPhoneNumber,rating,userRatingCount" });
    expect(transport.requests[0].body).toBeUndefined();
  });
  it("rejects a malformed Place ID without calling or spending", async () => {
    const { client, transport, budget } = make([ok({})]);
    for (const id of ["", "a/b", "../x", "x y", "ab"]) await expectKind(client.details(id), "bad_request");
    expect(transport.calls).toBe(0);
    expect(budget.requestsUsed).toBe(0);
  });
  it("treats an answer for a different place as invalid", async () => {
    const { client, usage } = make([ok({ id: "test-other-0001" })]);
    await expectKind(client.details("test-det-0002"), "invalid_response");
    expect(usage.events.at(-1)?.outcome).toBe("invalid_response");
  });
  it("not_found means the Place ID is stale (and is not retried)", async () => {
    const { client, transport } = make([err(404, { error: { status: "NOT_FOUND" } })]);
    const e = await expectKind(client.details("test-gone-0001"), "not_found");
    expect(e.code).toBe("NOT_FOUND");
    expect(transport.calls).toBe(1);
  });
  it("rejects a mask outside the whitelist", async () => {
    await expect(make([ok({})]).client.details("test-det-0003", { fields: ["reviews"] })).rejects.toBeInstanceOf(FieldMaskError);
  });
});

describe("retries, timeouts and rate limits", () => {
  it("retries a 500 and counts every attempt against the budget", async () => {
    const { client, transport, budget, usage } = make([err(503), ok({ places: [wirePlace("test-r-1")] })]);
    const page = await client.searchPage(Q);
    expect(page.places).toHaveLength(1);
    expect(transport.calls).toBe(2);
    expect(budget.requestsUsed).toBe(2);
    expect(usage.events.map((e) => [e.outcome, e.attempt])).toEqual([["http_error", 0], ["ok", 1]]);
    expect(sleeps).toEqual([500]);
  });
  it("backs off exponentially and gives up with a server error after the retries", async () => {
    const { client, transport } = make([err(500), err(500), err(500)], { random: () => 0 });
    const e = await expectKind(client.searchPage(Q), "server");
    expect(e.status).toBe(500);
    expect(transport.calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });
  it("retries a network failure, then reports it", async () => {
    const boom = { throws: new Error(`socket reset ${SENTINEL}`) };
    const { client, transport } = make([boom, boom, boom]);
    const e = await expectKind(client.searchPage(Q), "network");
    expect(transport.calls).toBe(3);
    expect(e.message).not.toContain(SENTINEL);
    const again = make([boom, ok({ places: [] })]);
    await expect(again.client.searchPage(Q)).resolves.toMatchObject({ places: [] });
  });
  it("times a hung attempt out, aborts it, retries, and finally reports a timeout", async () => {
    const { client, transport, usage } = make([{ hang: true }, { hang: true }, { hang: true }], { timeoutMs: 15 });
    await expectKind(client.searchPage(Q), "timeout");
    expect(transport.calls).toBe(3);
    expect(transport.aborted).toBe(3);
    expect(usage.events.every((e) => e.outcome === "timeout")).toBe(true);
  });
  it("recovers when a retry after a timeout succeeds", async () => {
    const { client } = make([{ hang: true }, ok({ places: [wirePlace("test-t-1")] })], { timeoutMs: 15 });
    await expect(client.searchPage(Q)).resolves.toMatchObject({ places: [expect.objectContaining({ placeId: "test-t-1" })] });
  });
  it("a short Retry-After on a 429 is honoured and retried", async () => {
    const { client, transport, usage } = make([err(429, {}, { "retry-after": "1" }), ok({ places: [] })]);
    await client.searchPage(Q);
    expect(transport.calls).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(usage.events[0].outcome).toBe("throttled");
  });
  it("a long Retry-After is surfaced as throttled with the wait, so the caller can save its place", async () => {
    const { client, transport } = make([err(429, { error: { status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "60" })]);
    const e = await expectKind(client.searchPage(Q), "throttled");
    expect(e.retryAfterMs).toBe(60_000);
    expect(e.code).toBe("RESOURCE_EXHAUSTED");
    expect(transport.calls).toBe(1);
    expect(describePlacesProblem(e)).toMatch(/60 seconds/);
  });
  it("a 429 without Retry-After waits one local interval, retries, then surfaces", async () => {
    const { client, transport } = make([err(429), err(429), err(429)], { rate: { rate: 5, burst: 100 } });
    const e = await expectKind(client.searchPage(Q), "throttled");
    expect(e.retryAfterMs).toBe(200);
    expect(transport.calls).toBe(3);
  });
  it("never retries other client errors, and maps their kinds", async () => {
    for (const [status, kind] of [[400, "bad_request"], [401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [422, "bad_request"]] as const) {
      const { client, transport } = make([err(status), ok({})]);
      await expectKind(client.searchPage(Q), kind);
      expect(transport.calls).toBe(1);
    }
  });
  it("a successful answer in an unexpected shape is invalid_response, not a crash", async () => {
    const { client, usage } = make([ok("not json object")]);
    await expectKind(client.searchPage(Q), "invalid_response");
    expect(usage.events[0].outcome).toBe("invalid_response");
  });
  it("the local rate limiter waits when the wait is short and throttles when it is long", async () => {
    let t = 0;
    const slow = make([ok({}), ok({}), ok({})], { rate: { rate: 1, burst: 1 }, maxWaitMs: 100, now: () => t });
    await slow.client.searchPage(Q);
    await expectKind(slow.client.searchPage(Q), "throttled");   // needs about 1000 ms, over the 100 ms maximum
    expect(slow.transport.calls).toBe(1);
    t += 1000;
    await slow.client.searchPage(Q);
    expect(slow.transport.calls).toBe(2);
    const fast = make([ok({}), ok({})], { rate: { rate: 20, burst: 1 }, maxWaitMs: 100, now: () => t });
    await fast.client.searchPage(Q); await fast.client.searchPage(Q);
    expect(sleeps).toEqual([50]);
  });
  it("TokenBucket refills with time", () => {
    let t = 0;
    const b = new TokenBucket({ rate: 2, burst: 2 }, () => t);
    b.take(); b.take();
    expect(b.waitMs()).toBe(500);
    t = 500;
    expect(b.waitMs()).toBe(0);
  });
});

describe("errors, usage records and secrecy", () => {
  it("error text is fixed: Google's message and body are never copied in", async () => {
    const { client } = make([err(400, { error: { status: "INVALID_ARGUMENT", message: `bad ${SENTINEL}`, details: [{ x: SENTINEL }] } })]);
    const e = await expectKind(client.searchPage(Q), "bad_request");
    expect(JSON.stringify({ m: e.message, c: e.code, k: e.kind, s: e.status, o: e.operation })).not.toContain(SENTINEL);
    expect(e.code).toBe("INVALID_ARGUMENT");
  });
  it("only a short upper-case token can become an error code", () => {
    expect(safeStatusCode("RESOURCE_EXHAUSTED")).toBe("RESOURCE_EXHAUSTED");
    for (const bad of ["resource exhausted", "Shop Name Here", `X${SENTINEL}`, "", 5, null, "AB", "A".repeat(50)]) expect(safeStatusCode(bad)).toBeUndefined();
  });
  it("usage events carry counts and codes only, never Google content", async () => {
    const { client, usage } = make([ok({ places: [wirePlace(`test-u-${SENTINEL}`.replace(/[^A-Za-z0-9_-]/g, ""), { displayName: { text: SENTINEL } })] })]);
    await client.searchPage(Q);
    expect(usage.events).toHaveLength(1);
    expect(JSON.stringify(usage.events)).not.toContain(SENTINEL);
    expect(Object.keys(usage.events[0]).sort()).toEqual(["at", "attempt", "durationMs", "operation", "outcome", "status"].sort());
  });
  it("a failing usage sink or a failing logger can never break a lookup", async () => {
    const sink: UsageSink = { record() { throw new Error("db down"); } };
    await expect(make([ok({})], { usage: sink }).client.searchPage(Q)).resolves.toBeDefined();
  });
  it("a budget gate that throws is not hidden", async () => {
    const gate: BudgetGate = { reserve: async () => { throw new Error("gate failed"); } };
    await expect(make([ok({})], { budget: gate }).client.searchPage(Q)).rejects.toThrow("gate failed");
  });
  it("describePlacesProblem never reveals more than the fixed text", () => {
    expect(describePlacesProblem(new PlacesError("budget", "searchText"))).toMatch(/spending cap/);
    expect(describePlacesProblem(new Error(`secret ${SENTINEL}`))).not.toContain(SENTINEL);
  });
  it("results are sealed Google data (frozen), and mapping carries the fetch time", async () => {
    const page = await make([ok({ places: [wirePlace("test-f-1")] })]).client.searchPage(Q);
    expect(Object.isFrozen(page.places[0])).toBe(true);
    expect(page.places[0].fetchedAt).toBe(new Date(1_000_000).toISOString());
  });
});

describe("cost estimate and query helpers", () => {
  it("estimates the pilot at the assumed (unverified) prices", () => {
    const e = estimateRun({ searchUnits: 8, maxPagesPerUnit: 3, maxDetailCalls: 100 });
    expect(e.maxRequests).toBe(124);
    expect(e.maxCostUsd).toBeCloseTo(24 * 0.035 + 100 * 0.02, 6);
    expect(estimateRun({ searchUnits: -1, maxPagesPerUnit: 3, maxDetailCalls: -5 })).toEqual({ maxRequests: 0, maxCostUsd: 0 });
    expect(ASSUMED_PRICE_USD_PER_1000).toEqual({ searchText: 35, placeDetails: 20 });
  });
  it("composes a text query from a term and a city", () => expect(buildTextQuery("  fashion   jewellery ", " Indore ")).toBe("fashion jewellery in Indore"));
});
