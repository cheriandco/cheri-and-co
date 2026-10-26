import { describe, expect, it, vi } from "vitest";
import { runB2CAgent } from "@/lib/b2c-agent";
import { requestAgent, validateEnquiry } from "@/lib/b2c-agent/client";
import { SAMPLE_CATALOGUE } from "@/mocks/catalogue";
import { POST } from "@/app/api/agents/b2c/run/route";
import type { CatalogueProduct } from "@/types/b2c-agent";

const run = (enquiry: string, catalogue?: CatalogueProduct[]) => runB2CAgent({ enquiry }, catalogue);
const byId = (id: string) => SAMPLE_CATALOGUE.find((p) => p.id === id)!;

describe("recommendations", () => {
  it("returns relevant matches with explicit reasons", () => {
    const r = run("Can you recommend minimal earrings for daily wear under ₹1500?");
    expect(r.intent).toBe("product_recommendation");
    expect(r.preferences).toMatchObject({ category: "earrings", style: "minimal", occasion: "daily", budgetMaxInr: 1500 });
    expect(r.recommendations.length).toBeGreaterThan(0);
    for (const p of r.recommendations) {
      expect(p.category).toBe("earrings");
      expect(p.samplePriceInr ?? 0).toBeLessThanOrEqual(1500);
      expect(p.matchReasons.length).toBeGreaterThan(0);
    }
    expect(r.recommendations.map((p) => p.productId)).toContain("SAMPLE-ERG-005");
    expect(r.autoAnswerPermitted).toBe(true);
    expect(r.escalation.required).toBe(false);
  });

  it("handles occasion/style requests without a category", () => {
    const r = run("Something traditional for a wedding");
    expect(r.intent).toBe("occasion_style_recommendation");
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it("escalates instead of guessing when nothing matches", () => {
    const r = run("Need a statement ring under 500");
    expect(r.recommendations).toEqual([]);
    expect(r.escalation).toMatchObject({ required: true, code: "no_confident_match" });
    expect(r.autoAnswerPermitted).toBe(false);
  });

  it("asks a clarifying question when there are no criteria", () => {
    const r = run("Can you suggest some jewellery?");
    expect(r.recommendations).toEqual([]);
    expect(r.suggestedNextAction.code).toBe("ask_clarifying_question");
  });
});

describe("price and missing information", () => {
  it("quotes only the sample price", () => {
    const r = run("How much is the Kundan Choker Necklace?");
    expect(r.intent).toBe("price_enquiry");
    expect(r.draftResponse).toContain("₹5,999");
    expect(r.draftResponse.toLowerCase()).toContain("sample price");
    expect(r.draftResponse).not.toMatch(/discount of|% off|free shipping/i);
  });

  it("does not invent a price the catalogue lacks", () => {
    const r = run("What is the price of the Adjustable Floral Ring?");
    expect(r.draftResponse).not.toMatch(/₹\s?\d/);
    expect(r.autoAnswerPermitted).toBe(false);
    expect(r.escalation).toMatchObject({ required: true, code: "missing_information" });
  });

  it("does not invent product facts such as material or weight", () => {
    const r = run("What material is the Jhumka Bloom Earrings made of and what is the weight?");
    expect(r.intent).toBe("product_details");
    expect(r.draftResponse).toContain("Dome jhumkas with a floral motif");
    expect(r.draftResponse).toMatch(/don't have .*(material|weight)/);
    expect(r.draftResponse).not.toMatch(/\d+\s?(g|gm|grams|carat)\b/i);
    expect(r.autoAnswerPermitted).toBe(false);
  });

  it("never states stock; availability is unknown", () => {
    expect(SAMPLE_CATALOGUE.every((p) => p.availability === "unknown")).toBe(true);
    const r = run("Is the Petal Stud Earrings in stock?");
    expect(r.intent).toBe("availability_enquiry");
    expect(r.draftResponse).toMatch(/can't (check|confirm)/);
    expect(r.draftResponse).not.toMatch(/\bis in stock\b|\bavailable now\b/i);
    expect(r.suggestedNextAction.code).toBe("check_stock_with_team");
    expect(r.autoAnswerPermitted).toBe(false);
  });

  it("gives no purchase link unless a valid URL is supplied", () => {
    const none = run("Send me the link to buy the Twist Band Ring");
    expect(none.intent).toBe("purchase_link_request");
    expect(none.draftResponse).not.toMatch(/https?:\/\//);
    expect(none.autoAnswerPermitted).toBe(false);

    const withUrl: CatalogueProduct[] = [{ ...byId("SAMPLE-RNG-001"), purchaseUrl: "https://example.com/twist-band" }];
    expect(run("Send me the link to buy the Twist Band Ring", withUrl).draftResponse).toContain("https://example.com/twist-band");

    const bad: CatalogueProduct[] = [{ ...byId("SAMPLE-RNG-001"), purchaseUrl: "javascript:alert(1)" }];
    expect(run("Send me the link to buy the Twist Band Ring", bad).draftResponse).not.toContain("javascript:");
  });
});

describe("escalation", () => {
  it.each([
    ["Where is my order? Please track it", "order_status", "order_status"],
    ["I want a refund for my ring", "return_refund", "return_refund"],
    ["I want to return this and get my money back", "return_refund", "return_refund"],
    ["The necklace arrived damaged, I'm very disappointed", "complaint", "complaint"],
  ] as const)("escalates %j", (text, intent, code) => {
    const r = run(text);
    expect(r.intent).toBe(intent);
    expect(r.escalation).toMatchObject({ required: true, code });
    expect(r.autoAnswerPermitted).toBe(false);
    expect(r.recommendations).toEqual([]);
    expect(r.suggestedNextAction.owner).toBe("human");
    expect(r.draftResponse).not.toMatch(/₹|https?:\/\/|will be (delivered|refunded)|within \d+ days/i);
  });

  it("gives an unclear enquiry no unsupported answer", () => {
    for (const text of ["hello", "asdf qwerty", "what's the weather like?"]) {
      const r = run(text);
      expect(r.intent).toBe("other");
      expect(r.escalation).toMatchObject({ required: true, code: "unclear_request" });
      expect(r.autoAnswerPermitted).toBe(false);
      expect(r.recommendations).toEqual([]);
      expect(r.draftResponse).not.toMatch(/₹|https?:\/\//);
    }
  });

  it("treats empty input as unclear, not as an answer", () => {
    const r = run("   ");
    expect(r.intent).toBe("other");
    expect(r.autoAnswerPermitted).toBe(false);
  });
});

describe("typed output contract", () => {
  it("returns every required field and prototype flags", () => {
    const r = run("Recommend a pearl necklace for a gift");
    expect(Object.keys(r).sort()).toEqual(
      ["autoAnswerPermitted", "dataSource", "draftResponse", "enquiry", "escalation", "intent", "intentConfidence", "messageSent", "preferences", "recommendations", "suggestedNextAction"],
    );
    expect(r.enquiry).toBe("Recommend a pearl necklace for a gift");
    expect(r.messageSent).toBe(false);
    expect(r.dataSource).toMatchObject({ kind: "prototype_sample_catalogue", verified: false });
    expect(r.intentConfidence).toBeGreaterThan(0);
    expect(r.intentConfidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(r.preferences.requestedMissingAttributes)).toBe(true);
  });

  it("is deterministic and does not mutate the catalogue", () => {
    const before = JSON.stringify(SAMPLE_CATALOGUE);
    expect(run("minimal ring under 1200")).toEqual(run("minimal ring under 1200"));
    expect(JSON.stringify(SAMPLE_CATALOGUE)).toBe(before);
  });

  it("labels all sample products as sample data", () => {
    expect(SAMPLE_CATALOGUE.every((p) => p.isSample && p.id.startsWith("SAMPLE-"))).toBe(true);
  });
});

describe("API route", () => {
  const post = (body: unknown) => POST(new Request("http://localhost/api/agents/b2c/run", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  it("returns a result for a valid enquiry", async () => {
    const res = await post({ enquiry: "earrings for a party" });
    expect(res.status).toBe(200);
    expect((await res.json()).messageSent).toBe(false);
  });
  it("rejects empty, missing, oversize and malformed input", async () => {
    expect((await post({ enquiry: "  " })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ enquiry: "x".repeat(1001) })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
  });
});

describe("UI request states", () => {
  it("rejects empty input without calling the network", async () => {
    const f = vi.fn();
    expect(validateEnquiry("  ")).toMatch(/Enter/);
    expect(await requestAgent("   ", f as unknown as typeof fetch)).toMatchObject({ status: "invalid" });
    expect(f).not.toHaveBeenCalled();
  });
  it("returns the result on success", async () => {
    const result = run("necklace for a wedding");
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
    expect(await requestAgent("necklace for a wedding", f as unknown as typeof fetch)).toEqual({ status: "done", result });
  });
  it("reports server errors and network failures instead of throwing", async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await requestAgent("hello", bad as unknown as typeof fetch)).toMatchObject({ status: "error" });
    const down = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await requestAgent("hello", down as unknown as typeof fetch)).toMatchObject({ status: "error" });
  });
});

describe("named-product enquiries (review fixes)", () => {
  it("answers about the named product instead of listing others when the customer wants to order it", () => {
    const r = run("I want to order the Kundan Choker Necklace");
    expect(r.draftResponse).toContain("Kundan Choker Necklace");
    expect(r.recommendations.map((x) => x.name)).toEqual(["Kundan Choker Necklace"]);
    expect(r.autoAnswerPermitted).toBe(false);
    expect(r.escalation.required).toBe(true);
    expect(r.draftResponse).not.toMatch(/https?:\/\//);
  });

  it("does not auto-answer a material-authenticity question", () => {
    const r = run("Is the Charm Bracelet real gold?");
    expect(r.draftResponse).toMatch(/material authenticity/);
    expect(r.autoAnswerPermitted).toBe(false);
  });

  it("disclaims discounts in generic recommendations", () => {
    expect(run("any offers on bridal sets?").draftResponse).toMatch(/discounts/);
  });
});

describe("pre-purchase care, policy, shipping and discount enquiries", () => {
  it("treats 'Will it tarnish?' as a product care question, not a complaint", () => {
    const r = run("Will it tarnish?");
    expect(r.intent).toBe("product_details");
    expect(r.draftResponse).toMatch(/don't have verified information on tarnish/);
    expect(r.autoAnswerPermitted).toBe(false);
    expect(r.escalation).toMatchObject({ required: true, code: "missing_information" });
    expect(r.draftResponse).not.toMatch(/won't tarnish|anti-?tarnish|will not tarnish/i);
  });

  it("still treats a received, tarnished item as a complaint", () => {
    for (const q of ["My necklace has tarnished after a week", "The ring I bought turned black", "my earrings faded"]) {
      expect(run(q).intent, q).toBe("complaint");
    }
  });

  it("says material care is unknown for a named product", () => {
    const r = run("Will the Petal Stud Earrings tarnish?");
    expect(r.intent).toBe("product_details");
    expect(r.draftResponse).toMatch(/tarnish/);
    expect(r.autoAnswerPermitted).toBe(false);
  });

  it("treats a pre-purchase return question as a policy enquiry, not a refund request", () => {
    for (const q of ["Can I return the earrings I want to buy?", "What is your return policy?", "Do you accept returns?", "If I buy this can I exchange it later?"]) {
      const r = run(q);
      expect(r.intent, q).toBe("return_policy_enquiry");
      expect(r.escalation).toMatchObject({ required: true, code: "missing_information" });
      expect(r.draftResponse).toMatch(/don't have a verified return/);
      expect(r.draftResponse).not.toMatch(/\d+\s*days|eligible|full refund|within/i);
    }
  });

  it("keeps real post-purchase returns and refunds as high-priority handovers", () => {
    for (const q of ["I want a refund for my ring", "I want to return my order", "I bought earrings and want to return them"]) {
      const r = run(q);
      expect(r.intent, q).toBe("return_refund");
      expect(r.escalation.priority).toBe("high");
    }
  });

  it("identifies shipping enquiries and promises nothing", () => {
    for (const q of ["Free shipping?", "Can you deliver by tomorrow?", "How much is delivery to Pune?", "Do you ship internationally?", "Is cash on delivery available?"]) {
      const r = run(q);
      expect(r.intent, q).toBe("shipping_enquiry");
      expect(r.draftResponse).toMatch(/don't have verified shipping/);
      expect(r.escalation).toMatchObject({ required: true, code: "missing_information" });
      expect(r.autoAnswerPermitted).toBe(false);
      expect(r.draftResponse).not.toMatch(/free shipping (is|on)|will (arrive|be delivered)|\d+\s*(days|hours)/i);
    }
  });

  it("identifies discount enquiries and promises nothing", () => {
    for (const q of ["Do you have a discount code?", "any offers on bridal sets?", "Any coupon available?", "Can you give a bulk discount?"]) {
      const r = run(q);
      expect(r.intent, q).toBe("discount_enquiry");
      expect(r.draftResponse).toMatch(/don't have verified information on discounts/);
      expect(r.escalation).toMatchObject({ required: true, code: "missing_information" });
      expect(r.autoAnswerPermitted).toBe(false);
      expect(r.draftResponse).not.toMatch(/\d+\s?%|promo code|use code/i);
    }
  });

  it("answers a best-price question about a named product with only the sample price", () => {
    const r = run("What's the best price you can do for the Kundan Choker Necklace?");
    expect(r.intent).toBe("discount_enquiry");
    expect(r.draftResponse).toContain("sample price");
    expect(r.autoAnswerPermitted).toBe(false);
  });

  it("keeps order-status wording out of shipping", () => {
    expect(run("Where is my order #123?").intent).toBe("order_status");
    expect(run("When will my order arrive?").intent).toBe("order_status");
    expect(run("My parcel has not been delivered").intent).toBe("order_status");
  });
});
