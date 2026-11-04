/** M4: the provisional B2C opportunity rules and the generic draft. Pure functions: no database. */
import { describe, expect, it } from "vitest";
import { b2cFollowUpDraft, CONSENT_WARNING, findOpportunities, hasUsableContact, THRESHOLDS, type OpportunityCustomer } from "@/lib/b2c-opportunities";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import type { Order, OrderStatus } from "@/types";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const C1: OpportunityCustomer = { id: "c1", name: "Meera Iyer", email: "meera@example.com", phone: "" };
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
let n = 0;
const order = (status: OrderStatus, days: number, customerId: string | null = "c1"): Order =>
  ({ id: `o${++n}`, customerId, retailerId: null, channel: "instagram", status, total: 1499, lineItems: [], orderedAt: ago(days) });
const kindFor = (orders: Order[], customer = C1) => findOpportunities([customer], orders, NOW)[0]?.kind ?? null;

describe("M4 thresholds and boundary days", () => {
  it("NO post-delivery check-in is offered: the database has an order date but no delivery date, so a delivered order 3 to 10 days old may not have arrived yet", () => {
    for (const d of [0, 2, 3, 5, 10, 10.9, 11]) expect(kindFor([order("delivered", d)]), String(d)).toBeNull();
  });
  it("nothing between 0 and 29 days for a delivered order", () => {
    for (const d of [0, 11, 20, 29, 29.9]) expect(kindFor([order("delivered", d)]), String(d)).toBeNull();
  });
  it("no category of opportunity is called a post-delivery check-in, for any age or status", () => {
    const statuses: OrderStatus[] = ["new", "paid", "shipped", "delivered", "cancelled", "returned"];
    for (const status of statuses) for (const d of [0, 1, 3, 5, 10, 11, 30, 91, 400]) expect(String(kindFor([order(status, d)]))).not.toMatch(/delivery|check/i);
  });
  it("repeat-purchase nudge: delivered 30 to 90 days ago, not 29 and not 91", () => {
    expect(kindFor([order("delivered", 29)])).toBeNull();
    expect(kindFor([order("delivered", 30)])).toBe("repeat_nudge");
    expect(kindFor([order("delivered", 90)])).toBe("repeat_nudge");
    expect(kindFor([order("delivered", 90.9)])).toBe("repeat_nudge");
  });
  it("win-back: delivered more than 90 days ago", () => {
    expect(kindFor([order("delivered", 91)])).toBe("win_back");
    expect(kindFor([order("delivered", 400)])).toBe("win_back");
  });
  it("unpaid/new order: status new for more than 3 days, not 3", () => {
    expect(kindFor([order("new", 3)])).toBeNull();
    expect(kindFor([order("new", 3.9)])).toBeNull(); // 3 whole days
    expect(kindFor([order("new", 4)])).toBe("unpaid_order");
    expect(kindFor([order("new", 0)])).toBeNull();
  });
  it("the documented thresholds are the approved provisional ones", () => {
    expect(THRESHOLDS).toEqual({ repeat: { min: 30, max: 90 }, winBackAfter: 90, unpaidAfter: 3 });
  });
  it("paid or shipped latest orders, future-dated orders and customers with no orders are not opportunities", () => {
    expect(kindFor([order("paid", 40)])).toBeNull();
    expect(kindFor([order("shipped", 120)])).toBeNull();
    expect(kindFor([order("delivered", -5)])).toBeNull();
    expect(kindFor([])).toBeNull();
  });
});

describe("M4 returned and cancelled orders", () => {
  it("a returned or cancelled latest order is flagged for human review, never drafted", () => {
    for (const status of ["returned", "cancelled"] as const) {
      const [o] = findOpportunities([C1], [order(status, 5)], NOW);
      expect(o).toMatchObject({ kind: "review_returned", draftable: false });
      expect(() => b2cFollowUpDraft(C1, o)).toThrow();
    }
  });
  it("it suppresses sales nudges: an older delivered order does not trigger a win-back after a later return", () => {
    expect(kindFor([order("delivered", 200), order("returned", 20)])).toBe("review_returned");
  });
  it("a returned order that is not the latest does not block a nudge on the newer delivered order", () => {
    expect(kindFor([order("returned", 200), order("delivered", 45)])).toBe("repeat_nudge");
  });
  it("a cancelled/returned order never counts as a delivered order", () => {
    expect(kindFor([order("cancelled", 60)])).toBe("review_returned");
  });
});

describe("M4 multiple orders and overlapping categories", () => {
  it("only the most recent order decides; one opportunity per customer, pointing at one order", () => {
    const old = order("delivered", 200);
    const newest = order("delivered", 45);
    const found = findOpportunities([C1], [old, newest], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "repeat_nudge", orderId: newest.id });
  });
  it("a newer delivery inside the suppressed window hides the older order's win-back, so it is not a second opportunity", () => {
    expect(findOpportunities([C1], [order("delivered", 200), order("delivered", 5)], NOW)).toEqual([]);
  });
  it("a recent paid order suppresses win-back and repeat nudges for older deliveries", () => {
    expect(kindFor([order("delivered", 200), order("paid", 1)])).toBeNull();
    expect(kindFor([order("delivered", 45), order("shipped", 2)])).toBeNull();
  });
  it("an old new order plus an older delivery is one unpaid opportunity, not two categories", () => {
    const stale = order("new", 6);
    const found = findOpportunities([C1], [order("delivered", 100), stale], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "unpaid_order", orderId: stale.id });
  });
  it("a delivered order that is newer than a stale new order wins; the stale order is not a second opportunity", () => {
    expect(findOpportunities([C1], [order("new", 20), order("delivered", 5)], NOW)).toEqual([]);
    expect(kindFor([order("new", 120), order("delivered", 45)])).toBe("repeat_nudge");
  });
  it("same-day orders are broken deterministically, whatever the input order", () => {
    const a = { ...order("delivered", 5), id: "a" };
    const b = { ...order("returned", 5), id: "b" };
    const one = findOpportunities([C1], [a, b], NOW)[0];
    const two = findOpportunities([C1], [b, a], NOW)[0];
    expect(one.orderId).toBe(two.orderId);
    expect(one.kind).toBe(two.kind);
  });
  it("orders belonging to other customers or to nobody are ignored", () => {
    expect(kindFor([order("delivered", 100, "someone-else"), order("delivered", 100, null)])).toBeNull();
  });
  it("results are sorted by category then recency, and are the same on every run", () => {
    const customers: OpportunityCustomer[] = [
      { id: "a", name: "A", email: "a@example.com", phone: "" }, { id: "b", name: "B", email: "b@example.com", phone: "" },
      { id: "c", name: "C", email: "c@example.com", phone: "" }, { id: "d", name: "D", email: "d@example.com", phone: "" },
    ];
    const orders = [order("delivered", 200, "a"), order("new", 9, "b"), order("returned", 2, "c"), order("delivered", 45, "d")];
    const kinds = findOpportunities(customers, orders, NOW).map((o) => o.kind);
    expect(kinds).toEqual(["unpaid_order", "repeat_nudge", "win_back", "review_returned"]);
    expect(findOpportunities(customers, [...orders].reverse(), NOW)).toEqual(findOpportunities(customers, orders, NOW));
  });
});

describe("M4 contact details", () => {
  it("usable contact means a plausible email or a phone with 6 or more digits", () => {
    expect(hasUsableContact({ email: "a@b.co", phone: "" })).toBe(true);
    expect(hasUsableContact({ email: "", phone: "+91 98765 43210" })).toBe(true);
    for (const bad of [{ email: "", phone: "" }, { email: "not-an-email", phone: "" }, { email: "", phone: "12345" }, { email: "  ", phone: "ab" }]) expect(hasUsableContact(bad)).toBe(false);
  });
  it("a customer with no usable contact is flagged and not draftable", () => {
    const [o] = findOpportunities([{ ...C1, email: "", phone: "" }], [order("delivered", 45)], NOW);
    expect(o).toMatchObject({ kind: "repeat_nudge", draftable: false, flags: ["contact_incomplete"] });
  });
  it("a customer with usable contact has no flag and can be drafted", () => {
    expect(findOpportunities([C1], [order("delivered", 45)], NOW)[0]).toMatchObject({ draftable: true, flags: [] });
  });
});

describe("M4 the generic draft", () => {
  const kinds = [["unpaid_order", order("new", 6)], ["repeat_nudge", order("delivered", 45)], ["win_back", order("delivered", 200)]] as const;
  for (const [kind, o] of kinds) {
    it(`${kind}: carries the consent warning, a placeholder, no price/stock/product/purchase detail, and passes the claim scan`, () => {
      const opp = findOpportunities([C1], [o], NOW)[0];
      expect(opp.kind).toBe(kind);
      const d = b2cFollowUpDraft(C1, opp);
      expect(d.title).toBe("B2C follow-up — Meera Iyer");
      expect(d.preview).toContain(CONSENT_WARNING);
      expect(d.preview).toContain("Nothing has been sent");
      expect(d.preview).toContain("[Add client-approved products or offer here, if any.]");
      expect(d.preview).toContain("Hi Meera,");
      expect(d.preview).toContain("meera@example.com");
      expect(d.preview).not.toMatch(/₹|\$|\d+\s?%|1499|discount|offer(?!\s+here)|in stock|sale/i);
      expect(d.preview).not.toMatch(/sample/i);
      expect(findProhibitedClaims(d.preview, [])).toEqual([]);
    });
  }
  it("a customer with no usable first name still gets a greeting", () => {
    const opp = findOpportunities([{ ...C1, name: " " }], [order("delivered", 45)], NOW)[0];
    expect(b2cFollowUpDraft({ ...C1, name: " " }, opp).preview).toContain("Hi there,");
  });
});
