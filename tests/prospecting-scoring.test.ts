import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING_CONFIG, RUBRIC_MAX, bandFor, detectDuplicate, evaluateCandidate, geographyFacts, hasUsableUrl, hasWord, normaliseText, phoneKey,
  scorePlace, toPersistable, validateScoringConfig, websiteDomain, decideOutcome, type OutcomeStatus, type ScoreResult, type ScoringConfig, type KnownBusiness,
} from "@/lib/prospecting/scoring";
import { ENABLED_SOURCE_TYPES, HumanContactError, acceptsHumanContactOnly, humanEnteredContact } from "@/lib/prospecting/human";
import { expiresAtFor, isFresh, mergeTransient } from "@/lib/prospecting/transient";
import { LOCATIONS, SENTINEL, anaya, cityGift, comps, place, sharma } from "./helpers/places-fixtures";

const score = (p = anaya(), extra: Partial<Parameters<typeof scorePlace>[0]> = {}) => scorePlace({ place: p, locations: LOCATIONS, ...extra });
const evalOf = (p = anaya(), extra: Partial<Parameters<typeof evaluateCandidate>[0]> = {}) => evaluateCandidate({ place: p, locations: LOCATIONS, ...extra });

describe("the three worked examples in the specification", () => {
  it("Anaya Fashion Jewellery: 24+8+15+10+10+10 = 77, high, needs review (never qualified)", () => {
    const r = score(anaya(), { detailsFresh: true });
    expect(Object.fromEntries(Object.entries(r.criteria).map(([k, c]) => [k, c.points]))).toEqual({ category: 24, assortment: 8, businessModel: 15, geography: 10, activity: 10, contactability: 10 });
    expect(r.total).toBe(77);
    expect(r.band).toBe("high");
    expect(evalOf(anaya(), { detailsFresh: true }).outcome).toEqual({ status: "needs_review", band: "high" });
    expect(r.flags).toContain("ASSORTMENT_NOT_VERIFIED");
    expect(r.flags).toContain("CATEGORY_INFERENCE_ONLY");
  });
  it("Sharma Gold and Diamond Jewellers: 16+0+15+10+10+8 = 59, high band with the precious-metal flag", () => {
    const r = score(sharma(), { detailsFresh: true });
    expect(Object.fromEntries(Object.entries(r.criteria).map(([k, c]) => [k, c.points]))).toEqual({ category: 16, assortment: 0, businessModel: 15, geography: 10, activity: 10, contactability: 8 });
    expect(r.total).toBe(59);
    expect(r.band).toBe("high");
    expect(r.flags).toContain("POSSIBLE_PRECIOUS_METAL_JEWELLER");
    expect(evalOf(sharma(), { detailsFresh: true }).outcome.status).toBe("needs_review");
  });
  it("City Gift Gallery: 16+4+10+10+6+1 = 47, medium", () => {
    const r = score(cityGift(), { detailsFresh: true });
    expect(Object.fromEntries(Object.entries(r.criteria).map(([k, c]) => [k, c.points]))).toEqual({ category: 16, assortment: 4, businessModel: 10, geography: 10, activity: 6, contactability: 1 });
    expect(r.total).toBe(47);
    expect(r.band).toBe("medium");
  });
  it("a permanently closed listing is rejected on a hard fact", () => {
    expect(evalOf(anaya({ businessStatus: "CLOSED_PERMANENTLY" })).outcome).toEqual({ status: "rejected", rule: "HARD_PERMANENTLY_CLOSED" });
  });
});

describe("the 77 ceiling and arithmetic invariants (exhaustive grid)", () => {
  it("no combination of Google-side facts exceeds 77, and the total is always the sum of the criteria", () => {
    const typeSets = [[], ["store"], ["jewelry_store", "store"], ["gift_shop", "store"], ["clothing_store"]];
    const names = [undefined, "Anaya Fashion Jewellery", "Gift Corner", "Plain Shop"];
    const statuses = [undefined, "OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"] as const;
    const ratings = [0, 5, 50];
    const addrs = [[], comps({ city: "Indore", state: "Madhya Pradesh" }), comps({ street: true, city: "Indore", state: "Madhya Pradesh" }), comps({ street: true, city: "Nagpur", state: "Maharashtra" })];
    let n = 0, max = 0;
    for (const types of typeSets) for (const displayName of names) for (const businessStatus of statuses) for (const userRatingCount of ratings)
      for (const addressComponents of addrs) for (const phone of [undefined, "0731 2345678"]) for (const web of [undefined, "https://x.example"]) for (const fresh of [false, true]) {
        const r = score(place({ displayName, types, primaryType: types[0], businessStatus, userRatingCount, addressComponents, nationalPhoneNumber: phone, websiteUri: web, formattedAddress: addressComponents.length ? "x" : undefined }), { detailsFresh: fresh });
        n++; max = Math.max(max, r.total);
        expect(r.total).toBeLessThanOrEqual(77);
        expect(r.criteria.category.points).toBeLessThanOrEqual(24);
        expect(r.criteria.assortment.points).toBeLessThanOrEqual(8);
        expect(r.total).toBe(Object.values(r.criteria).reduce((s, c) => s + c.points, 0));
        for (const [k, c] of Object.entries(r.criteria)) expect(c.points).toBeLessThanOrEqual(RUBRIC_MAX[k as keyof typeof RUBRIC_MAX]);
      }
    expect(n).toBe(5 * 4 * 4 * 3 * 4 * 2 * 2 * 2);
    expect(max).toBe(77);
  });
  it("only a person's confirmations can lift a score above 77, up to exactly 100", () => {
    const r = score(anaya(), { detailsFresh: true, human: { sellsFashionCategory: true, assortmentConfirmed: true, newVenture: true } });
    expect(r.criteria.category).toMatchObject({ points: 30, grade: "H" });
    expect(r.criteria.assortment).toMatchObject({ points: 25, grade: "H" });
    expect(r.total).toBe(100);
  });
  it("sums the maxima to 100", () => {
    expect(Object.values(RUBRIC_MAX).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("category fit (30; automation cap 24)", () => {
  it("24 for a relevant type and a fashion signal (V+I)", () => expect(score(anaya()).criteria.category).toMatchObject({ points: 24, grade: "VI", codes: ["CAT_TYPE_AND_NAME_SIGNAL"] }));
  it("16 for a relevant type alone (I)", () => expect(score(sharma()).criteria.category).toMatchObject({ points: 16, grade: "I", codes: ["CAT_TYPE_ONLY"] }));
  it("8 for a fashion signal with a generic store type (I)", () => expect(score(place({ displayName: "Fancy Corner", types: ["store"] })).criteria.category).toMatchObject({ points: 8, codes: ["CAT_NAME_SIGNAL_GENERIC_STORE"] }));
  it("0 for a signal word on a non-retail type (a fashion-named cafe earns nothing)", () => expect(score(place({ displayName: "Fashion Cafe", types: ["restaurant"] })).criteria.category).toMatchObject({ points: 0, grade: "V", codes: ["CAT_NOT_INDICATED"] }));
  it("0 and unknown when there is no type data", () => expect(score(place({ displayName: "Fashion Corner" })).criteria.category).toMatchObject({ points: 0, grade: "U", codes: ["CAT_NO_DATA"] }));
  it("a gift word alone never earns category points (it supports assortment only)", () => expect(score(place({ displayName: "Gift Corner", types: ["store"] })).criteria.category.points).toBe(0));
  it("matches whole words only", () => expect(score(place({ displayName: "Refashioned Things", types: ["store"] })).criteria.category.points).toBe(0));
  it("a person's confirmation gives 30, above the automation cap", () => expect(score(place({ types: [] }), { human: { sellsFashionCategory: true } }).criteria.category).toMatchObject({ points: 30, grade: "H" }));
  it("honours an edited automation cap", () => {
    const cfg: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, automationCaps: { category: 10, assortment: 2 } };
    const r = scorePlace({ place: anaya(), locations: LOCATIONS }, cfg);
    expect(r.criteria.category.points).toBe(10);
    expect(r.criteria.assortment.points).toBe(2);
  });
});

describe("assortment compatibility (25; automation cap 8; the other 17 only from a person)", () => {
  it("8 from a relevant type with a fashion signal", () => expect(score(anaya()).criteria.assortment).toMatchObject({ points: 8, grade: "I", codes: ["ASSORT_FASHION_SIGNAL"] }));
  it("4 from a gift shop or gifting word with retail evidence", () => {
    expect(score(cityGift()).criteria.assortment.points).toBe(4);
    expect(score(place({ displayName: "Gift Corner", types: ["store"] })).criteria.assortment.points).toBe(4);
  });
  it("0 and unknown for a plain jeweller: Google cannot see the stock", () => expect(score(sharma()).criteria.assortment).toMatchObject({ points: 0, grade: "U", codes: ["ASSORT_UNKNOWN"] }));
  it("a gift word on a non-retail place earns nothing", () => expect(score(place({ displayName: "Gift Cafe", types: ["restaurant"] })).criteria.assortment.points).toBe(0));
  it("confirmation adds 17 on top of the automated base (to 25), or 17 from zero", () => {
    expect(score(anaya(), { human: { assortmentConfirmed: true } }).criteria.assortment.points).toBe(25);
    expect(score(sharma(), { human: { assortmentConfirmed: true } }).criteria.assortment.points).toBe(17);
  });
  it("no assortment flag once a person confirmed", () => expect(score(anaya(), { human: { assortmentConfirmed: true } }).flags).not.toContain("ASSORTMENT_NOT_VERIFIED"));
});

describe("business-model fit (15)", () => {
  it("15 for a retail type with a street address", () => expect(score(anaya()).criteria.businessModel.points).toBe(15));
  it("10 for a retail type with a thin address", () => expect(score(cityGift()).criteria.businessModel.points).toBe(10));
  it("10 for a retail type with no address at all", () => expect(score(place({ types: ["jewelry_store"] })).criteria.businessModel.points).toBe(10));
  it("5 only from a person's reseller evidence when there is no shop", () => {
    expect(score(place({ types: ["restaurant"] }), { human: { resellerEvidence: true } }).criteria.businessModel).toMatchObject({ points: 5, grade: "H" });
    expect(score(place({ types: ["restaurant"] })).criteria.businessModel.points).toBe(0);
  });
  it("0 and unknown with no data", () => expect(score(place()).criteria.businessModel).toMatchObject({ points: 0, grade: "U" }));
  it("a street_number alone counts as a street address", () => expect(score(place({ types: ["store"], addressComponents: [{ types: ["street_number"], longText: "12" }] })).criteria.businessModel.points).toBe(15));
});

describe("geographic fit (10) and the verified-outside rule", () => {
  const geo = (city?: string, state?: string, street = false) => score(place({ types: ["store"], addressComponents: comps({ street, city, state }) })).criteria.geography;
  it("10 for a target city", () => expect(geo("Indore", "Madhya Pradesh")).toMatchObject({ points: 10, codes: ["GEO_TARGET_CITY"] }));
  it("is case and accent insensitive and accepts the short state name", () => {
    expect(geo("INDORE", "madhya pradesh").points).toBe(10);
    const p = place({ addressComponents: [{ types: ["locality"], longText: "Gwalior" }, { types: ["administrative_area_level_1"], longText: "x", shortText: "MP" }] });
    expect(scorePlace({ place: p, locations: [{ city: "Indore", state: "mp", kind: "target" }] }).criteria.geography.points).toBe(6);
  });
  it("6 for a target state but another city", () => expect(geo("Gwalior", "Madhya Pradesh")).toMatchObject({ points: 6, codes: ["GEO_TARGET_STATE"] }));
  it("3 for a configured expansion area", () => expect(geo("Nagpur", "Maharashtra")).toMatchObject({ points: 3, codes: ["GEO_EXPANSION_AREA"] }));
  it("0 and verified outside for another state", () => expect(geo("Chennai", "Tamil Nadu")).toMatchObject({ points: 0, grade: "V", codes: ["GEO_OUTSIDE"] }));
  it("0 and unknown without address components", () => expect(geo()).toMatchObject({ points: 0, grade: "U", codes: ["GEO_NO_DATA"] }));
  it("a district-level component is not mistaken for the city", () => {
    const p = place({ addressComponents: [{ types: ["administrative_area_level_2"], longText: "Indore" }, { types: ["locality"], longText: "Mhow" }, { types: ["administrative_area_level_1"], longText: "Madhya Pradesh" }] });
    expect(scorePlace({ place: p, locations: LOCATIONS }).criteria.geography.points).toBe(6);
  });
  it("outside is true only when a state is known and matches nothing", () => {
    const f = (city?: string, state?: string) => geographyFacts(place({ addressComponents: comps({ city, state }) }), LOCATIONS);
    expect(f("Chennai", "Tamil Nadu").outside).toBe(true);
    expect(f("Chennai").outside).toBe(false);        // city only, state unknown
    expect(f(undefined, "Tamil Nadu").outside).toBe(true);
    expect(f("Gwalior", "Madhya Pradesh").outside).toBe(false);
    expect(f("Nagpur", "Maharashtra").outside).toBe(false);
    expect(f().outside).toBe(false);
    expect(geographyFacts(place({ addressComponents: comps({ city: "Chennai", state: "Tamil Nadu" }) }), []).outside).toBe(false); // no configured location: nothing to be outside of
  });
});

describe("business activity (10)", () => {
  const act = (o: Partial<Parameters<typeof place>[0]>, human = {}) => score(place({ types: ["store"], ...o }), { human }).criteria.activity;
  it("6 for operational with no ratings", () => expect(act({ businessStatus: "OPERATIONAL" })).toMatchObject({ points: 6, grade: "V" }));
  it("8 for 1 to 9 ratings", () => { expect(act({ businessStatus: "OPERATIONAL", userRatingCount: 1 }).points).toBe(8); expect(act({ businessStatus: "OPERATIONAL", userRatingCount: 9 }).points).toBe(8); });
  it("10 (capped) for 10 or more ratings", () => { expect(act({ businessStatus: "OPERATIONAL", userRatingCount: 10 }).points).toBe(10); expect(act({ businessStatus: "OPERATIONAL", userRatingCount: 5000 }).points).toBe(10); });
  it("0 when temporarily closed, with a flag", () => {
    expect(act({ businessStatus: "CLOSED_TEMPORARILY", userRatingCount: 50 }).points).toBe(0);
    expect(score(anaya({ businessStatus: "CLOSED_TEMPORARILY" })).flags).toContain("TEMPORARILY_CLOSED");
  });
  it("0 when permanently closed", () => expect(act({ businessStatus: "CLOSED_PERMANENTLY", userRatingCount: 50 }).points).toBe(0));
  it("0 and unknown when the status is missing, even with ratings", () => expect(act({ userRatingCount: 50 })).toMatchObject({ points: 0, grade: "U" }));
  it("a person's new-venture note adds 4, capped at 10, and works without a status", () => {
    expect(act({ businessStatus: "OPERATIONAL", userRatingCount: 50 }, { newVenture: true }).points).toBe(10);
    expect(act({ businessStatus: "OPERATIONAL" }, { newVenture: true }).points).toBe(10);
    expect(act({}, { newVenture: true })).toMatchObject({ points: 4, grade: "H" });
  });
  it("never invents a new venture from Google data", () => expect(score(anaya({ userRatingCount: 0 })).criteria.activity.codes).not.toContain("ACT_NEW_VENTURE_HUMAN"));
});

describe("contactability and evidence quality (10), stored as yes/no flags only", () => {
  const pts = (o: Partial<Parameters<typeof place>[0]>, fresh = false) => score(place(o), { detailsFresh: fresh }).criteria.contactability;
  it("4 for a listed phone, but not for a number too short to be real", () => {
    expect(pts({ nationalPhoneNumber: "0731 2345678" }).codes).toEqual(["CONTACT_PHONE"]);
    expect(pts({ nationalPhoneNumber: "12345" }).points).toBe(0);
  });
  it("2 for a website; a social page also counts as a contact route", () => {
    expect(pts({ websiteUri: "https://shop.example" }).points).toBe(2);
    expect(pts({ websiteUri: "https://instagram.com/test" }).points).toBe(2);
    expect(pts({ websiteUri: "not a url" }).points).toBe(0);
  });
  it("2 only when four or more of the other criteria rest on V or H evidence", () => {
    expect(score(anaya()).criteria.contactability.codes).toContain("CONTACT_EVIDENCE_QUALITY");
    expect(score(sharma()).criteria.contactability.codes).not.toContain("CONTACT_EVIDENCE_QUALITY");
  });
  it("1 for a complete address and 1 for fresh details", () => {
    expect(score(anaya()).contactFlags.completeAddress).toBe(true);
    expect(score(cityGift()).contactFlags.completeAddress).toBe(false);
    expect(pts({}, true).codes).toEqual(["CONTACT_DETAILS_FRESH"]);
  });
  it("holds no values, only flags", () => {
    const r = score(anaya(), { detailsFresh: true });
    expect(r.contactFlags).toEqual({ hasPhone: true, hasWebsite: true, completeAddress: true, detailsFresh: true });
    expect(JSON.stringify(r)).not.toMatch(/2345678|anaya\.example/);
  });
});

describe("outcomes and exclusion rules (first match applies)", () => {
  it("duplicate beats every other rule, including a hard rejection", () => {
    const known: KnownBusiness[] = [{ id: "crm-1", source: "crm", phone: "+91 73123 45678" }];
    expect(evalOf(anaya({ businessStatus: "CLOSED_PERMANENTLY" }), { known }).outcome).toMatchObject({ status: "duplicate", rule: "DUP_PHONE", matchedId: "crm-1", undoable: true });
  });
  it("rejects only on verified hard facts: permanently closed, or verified outside every configured location", () => {
    expect(evalOf(anaya({ addressComponents: comps({ street: true, city: "Chennai", state: "Tamil Nadu" }) })).outcome).toEqual({ status: "rejected", rule: "HARD_OUTSIDE_LOCATIONS" });
  });
  it("does not reject when the address is unknown or only partly known", () => {
    expect(evalOf(anaya({ addressComponents: undefined, formattedAddress: undefined })).outcome.status).not.toBe("rejected");
    expect(evalOf(anaya({ addressComponents: comps({ city: "Chennai" }) })).outcome.status).not.toBe("rejected");
  });
  it("does not reject a business in the right state but another city", () => expect(evalOf(anaya({ addressComponents: comps({ street: true, city: "Gwalior", state: "Madhya Pradesh" }) })).outcome.status).toBe("needs_review"));
  it("does not reject temporarily closed businesses (flag only)", () => expect(evalOf(anaya({ businessStatus: "CLOSED_TEMPORARILY" })).outcome.status).toBe("needs_review"));
  it("no name keyword ever auto-rejects: wholesalers, gold jewellers, repair shops and online sellers go to a person", () => {
    for (const n of ["ABC Wholesale Jewellery Manufacturers", "Royal Gold Palace", "Quick Jewellery Repair", "Anaya Online Jewellery", "Pure Diamond House"]) {
      expect(evalOf(anaya({ displayName: n })).outcome.status).toBe("needs_review");
    }
  });
  it("insufficient information: fewer than three criteria with any evidence", () => {
    expect(evalOf(place({ placeId: "test-bare-0001" })).outcome).toEqual({ status: "insufficient_information" });
    expect(evalOf(place({ types: ["store"] })).outcome).toEqual({ status: "insufficient_information" });          // category + model only = 2
    expect(evalOf(place({ types: ["store"], businessStatus: "OPERATIONAL" })).outcome.status).toBe("needs_review"); // exactly 3
  });
  it("a low-scoring candidate is kept for review, never discarded", () => {
    const e = evalOf(place({ types: ["store"], businessStatus: "OPERATIONAL", addressComponents: comps({ city: "Indore", state: "Madhya Pradesh" }) }));
    expect(e.score.total).toBeLessThan(35);
    expect(e.outcome).toEqual({ status: "needs_review", band: "low" });
  });
  it("band boundaries: 55 high, 54 medium, 35 medium, 34 low", () => {
    expect([55, 54, 35, 34, 0, 100].map((t) => bandFor(t, DEFAULT_SCORING_CONFIG))).toEqual(["high", "medium", "medium", "low", "low", "high"]);
  });
  it("there is no qualified outcome anywhere", () => {
    const seen = new Set<string>();
    for (const p of [anaya(), sharma(), cityGift(), place(), anaya({ businessStatus: "CLOSED_PERMANENTLY" })]) seen.add(evalOf(p, { human: { sellsFashionCategory: true, assortmentConfirmed: true } }).outcome.status);
    expect([...seen].every((s) => ["duplicate", "rejected", "insufficient_information", "needs_review"].includes(s))).toBe(true);
    // @ts-expect-error "qualified" is not an outcome the system can express
    const bad: OutcomeStatus = "qualified";
    expect(bad).toBe("qualified");
  });
  it("even a perfect score with every human confirmation only routes to a person", () => {
    const e = evalOf(anaya(), { detailsFresh: true, human: { sellsFashionCategory: true, assortmentConfirmed: true, newVenture: true } });
    expect(e.score.total).toBe(100);
    expect(e.outcome).toEqual({ status: "needs_review", band: "high" });
  });
  it("decideOutcome can re-decide from a stored score", () => {
    const s = score(anaya());
    expect(decideOutcome(s, undefined)).toEqual({ status: "needs_review", band: "high" });
  });
});

describe("review flags", () => {
  const flags = (n: string, types = ["jewelry_store", "store"]) => score(place({ displayName: n, types, primaryType: types[0] })).flags;
  it("precious metal only without a fashion signal, and only for jewellery stores", () => {
    expect(flags("Royal Gold Palace")).toContain("POSSIBLE_PRECIOUS_METAL_JEWELLER");
    expect(flags("Fashion Gold Covering")).not.toContain("POSSIBLE_PRECIOUS_METAL_JEWELLER");
    expect(flags("Royal Gold Palace", ["store"])).not.toContain("POSSIBLE_PRECIOUS_METAL_JEWELLER");
    expect(flags("Marigold Gifts")).not.toContain("POSSIBLE_PRECIOUS_METAL_JEWELLER");
  });
  it("manufacturer or wholesaler wording is flagged, not treated as a partner", () => {
    expect(flags("Delhi Jewellery Wholesalers")).toContain("POSSIBLE_MANUFACTURER_OR_WHOLESALER");
    expect(flags("Plain Retail")).not.toContain("POSSIBLE_MANUFACTURER_OR_WHOLESALER");
  });
  it("repair and online wording", () => {
    expect(flags("Quick Repair Centre")).toContain("REPAIR_ONLY_WORDING");
    expect(flags("Jewel Online Store")).toContain("ONLINE_ONLY_INDICATION");
  });
  it("category inference is flagged unless a person confirmed the category", () => {
    expect(score(anaya()).flags).toContain("CATEGORY_INFERENCE_ONLY");
    expect(score(anaya(), { human: { sellsFashionCategory: true } }).flags).not.toContain("CATEGORY_INFERENCE_ONLY");
  });
  it("flags never change the points", () => expect(score(anaya({ displayName: "Anaya Fashion Online Repair" })).total).toBe(score(anaya()).total));
});

describe("no fabricated information", () => {
  it("an empty place earns zero everywhere and lists every criterion as unknown", () => {
    const r = score(place());
    expect(r.total).toBe(0);
    expect(r.unknowns).toEqual(["category", "assortment", "businessModel", "geography", "activity", "contactability"]);
  });
  it("is deterministic and does not modify its input", () => {
    const p = anaya();
    const a = score(p, { detailsFresh: true });
    const b = score(p, { detailsFresh: true });
    expect(a).toEqual(b);
    expect(p).toEqual(anaya());
  });
  it("records the configuration version used", () => expect(score().configVersion).toBe(DEFAULT_SCORING_CONFIG.version));
  it("absent ratings are not treated as zero evidence of activity", () => expect(score(anaya({ userRatingCount: undefined })).criteria.activity.points).toBe(6));
});

describe("duplicate detection (in memory; only codes and ids come back)", () => {
  const known = (o: Partial<KnownBusiness>): KnownBusiness => ({ id: "k1", source: "crm", ...o });
  it("matches by Place ID, phone, website domain, then name plus locality, in that order", () => {
    const p = anaya();
    expect(detectDuplicate(p, [known({ placeId: p.placeId })])).toMatchObject({ rule: "DUP_PLACE_ID", undoable: false });
    expect(detectDuplicate(p, [known({ phone: "073123 45678" })])).toMatchObject({ rule: "DUP_PHONE", undoable: true });
    expect(detectDuplicate(p, [known({ website: "http://www.ANAYA.example/contact" })])).toMatchObject({ rule: "DUP_WEBSITE_DOMAIN" });
    expect(detectDuplicate(p, [known({ name: "ANAYA fashion  jewellery", locality: "indore" })])).toMatchObject({ rule: "DUP_NAME_LOCALITY" });
    expect(detectDuplicate(p, [known({ phone: "0731 2345678", website: "anaya.example" }), known({ id: "k2", placeId: p.placeId })])?.rule).toBe("DUP_PLACE_ID");
  });
  it("never matches on absent or too-short values", () => {
    const p = anaya({ nationalPhoneNumber: undefined, websiteUri: undefined, displayName: undefined });
    expect(detectDuplicate(p, [known({}), known({ id: "k2", phone: "12345" })])).toBeUndefined();
    expect(detectDuplicate(anaya({ nationalPhoneNumber: "12345" }), [known({ phone: "12345" })])).toBeUndefined();
  });
  it("a shared social or directory host is never evidence of a duplicate", () => {
    const p = anaya({ websiteUri: "https://www.instagram.com/anaya" });
    expect(detectDuplicate(p, [known({ website: "https://instagram.com/other" })])).toBeUndefined();
    expect(websiteDomain("https://shop.myshopify.com")).toBeUndefined();
  });
  it("same name in a different locality is not a duplicate", () => expect(detectDuplicate(anaya(), [known({ name: "Anaya Fashion Jewellery", locality: "Bhopal" })])).toBeUndefined());
  it("skips the candidate's own cache entry", () => {
    const p = anaya();
    expect(detectDuplicate(p, [{ id: p.placeId, source: "cache", placeId: p.placeId, phone: "0731 2345678" }])).toBeUndefined();
  });
  it("returns no Google text", () => {
    const p = anaya({ displayName: `${SENTINEL} Shop`, nationalPhoneNumber: "0731 2345678" });
    const m = detectDuplicate(p, [known({ phone: "0731 2345678" })]);
    expect(JSON.stringify(m)).not.toContain(SENTINEL);
  });
});

describe("what may be stored permanently", () => {
  const sentinelPlace = anaya({ displayName: `${SENTINEL} Fashion Jewellery`, nationalPhoneNumber: `0731 ${SENTINEL}`, websiteUri: `https://${SENTINEL}.example`, formattedAddress: `${SENTINEL} Road` });
  it("the persisted evaluation never contains Google text, in either mode", () => {
    const e = evalOf(sentinelPlace, { detailsFresh: true });
    for (const mode of ["codes", "band_total"] as const) expect(JSON.stringify(toPersistable(e, mode))).not.toContain(SENTINEL);
    expect(JSON.stringify(e)).not.toContain(SENTINEL);
  });
  it("codes mode keeps points, rule codes and flags; band_total keeps only status, band and total (the legal fallback)", () => {
    const e = evalOf(anaya(), { detailsFresh: true });
    const codes = toPersistable(e, "codes");
    expect(codes.points?.category).toBe(24);
    expect(codes.codes).toContain("CAT_TYPE_AND_NAME_SIGNAL");
    expect(codes.flags).toContain("ASSORTMENT_NOT_VERIFIED");
    const lean = toPersistable(e, "band_total");
    expect(lean).toEqual({ configVersion: DEFAULT_SCORING_CONFIG.version, status: "needs_review", band: "high", total: 77 });
  });
  it("duplicate and rejection results keep their rule code", () => {
    expect(toPersistable(evalOf(anaya({ businessStatus: "CLOSED_PERMANENTLY" })), "band_total").ruleCode).toBe("HARD_PERMANENTLY_CLOSED");
    expect(toPersistable(evalOf(anaya(), { known: [{ id: "c1", source: "crm", phone: "0731 2345678" }] }), "band_total")).toMatchObject({ ruleCode: "DUP_PHONE", matchedId: "c1" });
  });
});

describe("configuration", () => {
  it("the default configuration is valid", () => expect(validateScoringConfig(DEFAULT_SCORING_CONFIG)).toEqual([]));
  it("rejects bad bands, caps and empty lists", () => {
    expect(validateScoringConfig({ ...DEFAULT_SCORING_CONFIG, bands: { high: 30, medium: 40 } })).not.toEqual([]);
    expect(validateScoringConfig({ ...DEFAULT_SCORING_CONFIG, automationCaps: { category: 31, assortment: 8 } })).not.toEqual([]);
    expect(validateScoringConfig({ ...DEFAULT_SCORING_CONFIG, categorySignalWords: [] })).not.toEqual([]);
    expect(validateScoringConfig({ ...DEFAULT_SCORING_CONFIG, version: " " })).not.toEqual([]);
  });
  it("edited bands change the band, not the points", () => {
    const cfg: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, bands: { high: 80, medium: 60 } };
    const r: ScoreResult = scorePlace({ place: anaya(), locations: LOCATIONS, detailsFresh: true }, cfg);
    expect(r.total).toBe(77);
    expect(r.band).toBe("medium");
  });
});

describe("normalisers", () => {
  it("normaliseText", () => { expect(normaliseText("  Café  Ánaya-&-Co. ")).toBe("cafe anaya co"); expect(normaliseText(undefined)).toBe(""); });
  it("hasWord: whole words, simple plurals, phrases; never inside another word", () => {
    expect(hasWord("Gold Palace", "gold")).toBe(true);
    expect(hasWord("Marigold", "gold")).toBe(false);
    expect(hasWord("Fancy Accessories", "accessories")).toBe(true);
    expect(hasWord("Ladies Fancy Stores", "fancy")).toBe(true);
    expect(hasWord("E-Commerce Hub", "e commerce")).toBe(true);
    expect(hasWord("", "gold")).toBe(false);
    expect(hasWord("Gold", "")).toBe(false);
  });
  it("phoneKey uses the last 10 digits and needs at least 7", () => {
    expect(phoneKey("+91 (731) 234-5678")).toBe("7312345678");
    expect(phoneKey("0731 2345678")).toBe("7312345678");
    expect(phoneKey("123456")).toBeUndefined();
    expect(phoneKey(undefined)).toBeUndefined();
  });
  it("websiteDomain and hasUsableUrl", () => {
    expect(websiteDomain("HTTPS://www.Shop.example/path?x=1")).toBe("shop.example");
    expect(websiteDomain("shop.example")).toBe("shop.example");
    expect(websiteDomain("localhost")).toBeUndefined();
    expect(websiteDomain("")).toBeUndefined();
    expect(hasUsableUrl("shop.example")).toBe(true);
    expect(hasUsableUrl("http://")).toBe(false);
  });
});

describe("class G and class P stay apart", () => {
  it("expiry is clamped to 1 to 30 days and refuses a bad date", () => {
    const t = "2026-11-16T00:00:00.000Z";
    expect(expiresAtFor(t)).toBe("2026-11-23T00:00:00.000Z");
    expect(expiresAtFor(t, 400)).toBe("2026-12-16T00:00:00.000Z");
    expect(expiresAtFor(t, 0)).toBe("2026-11-17T00:00:00.000Z");
    expect(expiresAtFor(t, Number.NaN)).toBe("2026-11-23T00:00:00.000Z");
    expect(() => expiresAtFor("not a date")).toThrow();
  });
  it("expired data is not fresh", () => {
    const now = new Date("2026-11-20T00:00:00.000Z");
    expect(isFresh("2026-11-21T00:00:00.000Z", now)).toBe(true);
    expect(isFresh("2026-11-20T00:00:00.000Z", now)).toBe(false);
    expect(isFresh("garbage", now)).toBe(false);
  });
  it("merging details keeps the base and refuses a different place", () => {
    const m = mergeTransient(place({ placeId: "test-merge-1", displayName: "Base", types: ["store"] }), place({ placeId: "test-merge-1", nationalPhoneNumber: "0731 2345678", fetchedAt: "2026-11-17T00:00:00.000Z" }));
    expect(m).toMatchObject({ displayName: "Base", nationalPhoneNumber: "0731 2345678", types: ["store"], fetchedAt: "2026-11-17T00:00:00.000Z" });
    expect(() => mergeTransient(place({ placeId: "test-merge-1" }), place({ placeId: "test-merge-2" }))).toThrow();
  });
  it("a sealed place is frozen", () => expect(Object.isFrozen(anaya())).toBe(true));
  it("person-entered contact needs an allowed source, a reference and an attestation; google_places is refused", () => {
    const base = { businessName: "Test Shop", sourceType: "own_website", sourceReference: "https://shop.example/contact", attestedBy: "user-1", attested: true };
    expect(humanEnteredContact(base)).toMatchObject({ sourceType: "own_website", businessName: "Test Shop" });
    expect(() => humanEnteredContact({ ...base, sourceType: "google_places" })).toThrow(HumanContactError);
    expect(() => humanEnteredContact({ ...base, sourceType: "trade_directory_permitted" })).toThrow(HumanContactError); // disabled by default (R7)
    expect(() => humanEnteredContact({ ...base, attested: false })).toThrow(HumanContactError);
    expect(() => humanEnteredContact({ ...base, sourceReference: "  " })).toThrow(HumanContactError);
    expect(() => humanEnteredContact({ ...base, attestedBy: "" })).toThrow(HumanContactError);
    expect(() => humanEnteredContact({ ...base, businessName: " " })).toThrow(HumanContactError);
    expect(ENABLED_SOURCE_TYPES).not.toContain("google_places");
  });
  it("Google data cannot be passed where person-entered contact is required (compile-time)", () => {
    // @ts-expect-error a GoogleTransient is not a HumanEnteredContact
    expect(() => acceptsHumanContactOnly(anaya())).not.toThrow();
    const ok = humanEnteredContact({ businessName: "Test Shop", sourceType: "referral", sourceReference: "referral 12 Nov", attestedBy: "u1", attested: true });
    expect(acceptsHumanContactOnly(ok)).toBe("referral");
  });
});
