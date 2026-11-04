/** Pure, rule-based helpers shared by the five agent demos and the orchestrator. No I/O, no AI model, no network.
 *  Everything here produces SAMPLE suggestions that a human must approve before anything would happen. */
import type { DiscoveryCandidate } from "@/mocks/agent-samples";
import type { AgentKey, AmazonRow, Approval, Conversation, Deal, PipelineStage, Retailer, Task, Temperature } from "@/types";

export const SAMPLE_BADGE = "SAMPLE · simulated";

/* ---------- B2B: qualification ---------- */

export interface Factor { label: string; ok: boolean; points: number; note: string }

export function scoreCandidate(s: DiscoveryCandidate["signals"]): { score: number; factors: Factor[] } {
  const factors: Factor[] = [
    { label: "Stocks jewellery or accessories", ok: s.stocksJewellery, points: 30, note: s.stocksJewellery ? "Category fits the Cheri & Co. range" : "Not an obvious category fit" },
    { label: "City tier", ok: s.tier <= 2, points: s.tier === 1 ? 20 : s.tier === 2 ? 20 : 8, note: s.tier <= 2 ? "Tier-1/2 city, in the current focus" : "Tier-3 city, lower priority" },
    { label: "Instagram presence", ok: s.hasInstagram, points: 15, note: s.hasInstagram ? "Active handle to review" : "No handle found" },
    { label: "Website", ok: s.hasWebsite, points: 10, note: s.hasWebsite ? "Website listed" : "No website listed" },
    { label: "Multiple stores", ok: s.stores > 1, points: Math.min(25, 10 + (s.stores - 1) * 8), note: s.stores > 1 ? `${s.stores} stores` : "Single store" },
  ];
  const score = Math.min(100, factors.reduce((n, f) => n + (f.ok ? f.points : Math.round(f.points / 4)), 0));
  return { score, factors };
}

export const temperatureFor = (score: number): Temperature => (score >= 75 ? "HOT" : score >= 55 ? "WARM" : "COLD");

export function qualificationFactors(r: Retailer): Factor[] {
  const jewelleryCategory = /jewel|accessor|boutique|gift|fashion|concept/i.test(r.category);
  const cityTier1 = /mumbai|delhi|bengaluru|pune|hyderabad|jaipur|kolkata|chennai/i.test(r.location);
  return [
    { label: "Category fit", ok: jewelleryCategory, points: 30, note: jewelleryCategory ? `${r.category}, relevant to the range` : `${r.category}, weaker fit` },
    { label: "Location", ok: cityTier1, points: 20, note: cityTier1 ? "Major metro in the current focus" : "Smaller city, lower priority" },
    { label: "Instagram presence", ok: r.instagram.startsWith("@"), points: 15, note: r.instagram.startsWith("@") ? r.instagram : "No handle on record" },
    { label: "Named contact", ok: !/to be confirmed|unknown/i.test(r.contact), points: 15, note: r.contact },
    { label: "Recent engagement", ok: !/days? ago/i.test(r.lastActivity) || r.lastActivity.startsWith("1 "), points: 20, note: `Last activity: ${r.lastActivity}` },
  ];
}

/** What a sales person would do next with this retailer, by pipeline stage. */
export function followUpFor(r: Pick<Retailer, "stage" | "business" | "temperature" | "contact">): { title: string; reason: string } {
  const who = /to be confirmed/i.test(r.contact) ? "the owner" : r.contact;
  const map: Record<PipelineStage, { title: string; reason: string }> = {
    new: { title: `Send an intro email to ${who}`, reason: "New lead with no outreach yet." },
    qualified: { title: `Send the wholesale catalogue to ${who}`, reason: "Qualified and ready for a first offer." },
    contacted: { title: `Follow up with ${who} after the first email`, reason: "Contacted, no reply recorded yet." },
    interested: { title: `Offer a sample box to ${who}`, reason: "Interest shown. A sample box moves it forward." },
    negotiation: { title: `Confirm terms and pack mix with ${who}`, reason: "In negotiation. Close the open points." },
    won: { title: `Check in with ${who} on the first reorder`, reason: "Won. Protect the relationship." },
    lost: { title: "Revisit next season", reason: "Marked lost. Park it and review later." },
  };
  return map[r.stage];
}

export function followUpEmail(r: Retailer): string {
  const f = followUpFor(r);
  const name = /to be confirmed/i.test(r.contact) ? "there" : r.contact.split(" ")[0];
  return [
    `To: ${r.contact} (${r.business}) — SAMPLE, not sent`,
    `Subject: ${f.title.replace(/ to .*/, "")} — Cheri & Co.`,
    "",
    `Hi ${name},`,
    "",
    `We are Cheri & Co., a Korean-inspired minimal jewellery brand. We curate trend-stable pieces and sell them as single pieces and in combo packs of 2, 3, 6 and 10.`,
    `${f.reason} We would love to share how this could work for ${r.business}.`,
    "",
    "[Prices, terms and product details to be supplied by the client before any real outreach.]",
    "",
    "Warm regards,",
    "Cheri & Co. sales team",
  ].join("\n");
}

/** The plain template follow-up for a real retailer. Unlike the sample email it has no SAMPLE wording and states no prices,
 *  terms or product claims: the team adds those before anything is sent. It is a template, not AI-written text. */
export function liveFollowUpDraft(r: Pick<Retailer, "stage" | "business" | "temperature" | "contact" | "email">): { title: string; preview: string } {
  const f = followUpFor(r);
  const known = r.contact.trim() && !/to be confirmed|not recorded/i.test(r.contact);
  const name = known ? r.contact.trim().split(/\s+/)[0] : "there";
  return {
    title: `Follow-up email — ${r.business}`,
    preview: [
      `To: ${known ? r.contact.trim() : "the owner"} (${r.business})${r.email.trim() && !/not recorded/i.test(r.email) ? ` <${r.email.trim()}>` : ""}`,
      `Subject: ${f.title.replace(/ to .*/, "")} — Cheri & Co.`,
      "",
      `Hi ${name},`,
      "",
      "We are Cheri & Co. We would love to share how our jewellery could work for " + r.business + ".",
      f.reason,
      "",
      "[Add the products, prices and terms here before sending. Nothing has been sent.]",
      "",
      "Warm regards,",
      "Cheri & Co. sales team",
    ].join("\n"),
  };
}

/* ---------- B2C ---------- */

export function suggestedReplyFor(c: Conversation): string {
  const ai = [...c.messages].reverse().find((m) => m.from === "ai");
  const text = ai?.text.replace(/^Draft ready:\s*/i, "").replace(/^[“"]|[”"]$/g, "").trim();
  return text || `Hi ${c.customer.split(" ")[0]}, thank you for your message about ${c.product}. [Details to be supplied by the client.]`;
}

/* ---------- Amazon ---------- */

export function amazonActionFor(row: AmazonRow): { type: Approval["type"]; title: string; preview: string } {
  const isPrice = /₹|price/i.test(row.recommendation);
  return {
    type: isPrice ? "Pricing change" : "Amazon listing",
    title: `SAMPLE · ${row.product}: ${row.recommendation}`,
    preview: `${row.recommendation}\nDemand ${row.demand}, competition ${row.competition}, average market price ₹${row.avgPrice}, opportunity score ${row.opportunity}.\nSAMPLE rule-based suggestion. Nothing is changed on Amazon.`,
  };
}

export function pricePosition(ourPrice: number, low: number, high: number): { pct: number; label: string } {
  const pct = Math.max(0, Math.min(100, Math.round(((ourPrice - low) / Math.max(1, high - low)) * 100)));
  return { pct, label: pct > 66 ? "Upper end of market" : pct < 33 ? "Lower end of market" : "Mid market" };
}

/* ---------- CRM / orchestrator suggestions ---------- */

export interface Suggestion { key: string; agent: AgentKey; title: string; reason: string; href: string; priority: "high" | "medium" | "low"; due: string }

export function buildSuggestions(input: { tasks: Task[]; deals: Deal[]; retailers: Retailer[]; approvals: Approval[]; amazon: AmazonRow[] }): Suggestion[] {
  const out: Suggestion[] = [];
  const openTasks = new Set(input.tasks.filter((t) => t.status === "open").map((t) => t.title));
  const add = (s: Suggestion) => { if (!openTasks.has(s.title) && !out.some((x) => x.key === s.key)) out.push(s); };

  for (const r of input.retailers.filter((x) => x.temperature === "HOT" && x.stage !== "won" && x.stage !== "lost").slice(0, 3)) {
    const f = followUpFor(r);
    add({ key: `b2b-${r.id}`, agent: "b2b", title: f.title, reason: `${r.business} is a hot lead (score ${r.score}). ${f.reason}`, href: `/retailers/${r.id}`, priority: "high", due: "Today" });
  }
  for (const d of input.deals.filter((x) => x.stage === "negotiation")) {
    add({ key: `crm-${d.id}`, agent: "crm", title: `Move ${d.business} from negotiation to a decision`, reason: "Deal in negotiation. Agree terms or set a decision date.", href: `/retailers/${d.retailerId}`, priority: "high", due: "This week" });
  }
  const top = [...input.amazon].sort((a, b) => b.opportunity - a.opportunity)[0];
  if (top) add({ key: `amazon-${top.id}`, agent: "amazon", title: `Review Amazon opportunity: ${top.product}`, reason: `Opportunity score ${top.opportunity}. ${top.recommendation}`, href: "/amazon?tab=recommendations", priority: "medium", due: "This week" });
  const pending = input.approvals.filter((a) => a.status === "pending").length;
  if (pending) add({ key: "crm-approvals", agent: "crm", title: `Clear ${pending} pending approval${pending > 1 ? "s" : ""}`, reason: "Agents are waiting for a human decision.", href: "/approvals", priority: pending > 5 ? "high" : "medium", due: "Today" });
  return out;
}
