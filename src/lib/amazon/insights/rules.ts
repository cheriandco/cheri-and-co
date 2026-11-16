/** Deterministic Amazon insights. Pure functions: no I/O, no randomness, no AI. Every insight carries evidence (the metric, its value, where it came from and
 *  the period), because an insight without evidence is not allowed to exist (the database also enforces a non-empty evidence array).
 *
 *  Thresholds below are PROVISIONAL. They are reasonable starting points for a small seller, not tuned against this client's real sales; the client should
 *  review them once real data exists (docs/M5_AMAZON_INTELLIGENCE.md). Nothing here changes anything on Amazon: recommendations are text for a person. */
import type { InsightRecord, InventoryRow, ProductRow, SalesLine } from "../repo";

export const THRESHOLDS = {
  topSellers: 3,
  trendMinPriorUnits: 10,
  trendChangePct: 20,
  lowCoverActDays: 7,
  lowCoverWatchDays: 14,
  riskMinUnits: 5,
  riskMinSharePct: 10,
  unusualMinPriorUnits: 20,
  unusualHighRatio: 2,
  unusualLowRatio: 0.4,
  maxPerRule: 10,
} as const;

export interface Evidence { metric: string; value: string | number; source: string; period?: string }
export interface RulesInput { now: Date; lines: SalesLine[]; products: ProductRow[]; inventory: InventoryRow[] }

const DAY = 86_400_000;
const SRC_ORDERS = "Amazon orders (synced)";
const SRC_FBA = "Amazon FBA inventory (synced)";
const SRC_LISTINGS = "Amazon listings (synced)";

/** ISO week label, used so regenerating within a week updates nothing and a new week produces fresh insights. */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const skuOf = (l: SalesLine) => l.sellerSku ?? l.asin;
function unitsBySku(lines: SalesLine[], from: number, to: number): Map<string, { units: number; title: string | null }> {
  const out = new Map<string, { units: number; title: string | null }>();
  for (const l of lines) {
    const t = Date.parse(l.orderedAt);
    const k = skuOf(l);
    if (!k || !(t >= from && t < to)) continue;
    const cur = out.get(k) ?? { units: 0, title: l.title };
    cur.units += l.quantity;
    out.set(k, cur);
  }
  return out;
}
const total = (m: Map<string, { units: number }>) => [...m.values()].reduce((s, v) => s + v.units, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);
const label = (sku: string, title: string | null) => (title ? `${title} (${sku})` : sku);

export function generateInsights(input: RulesInput): InsightRecord[] {
  const now = input.now.getTime();
  const wk = weekKey(input.now);
  const w30 = now - 30 * DAY, w60 = now - 60 * DAY;
  const last30 = unitsBySku(input.lines, w30, now + 1);
  const prior30 = unitsBySku(input.lines, w60, w30);
  const period30 = `${iso(w30).slice(0, 10)} to ${iso(now).slice(0, 10)}`;
  const out: InsightRecord[] = [];

  // 1. Top-selling SKUs
  const ranked = [...last30.entries()].filter(([, v]) => v.units > 0).sort((a, b) => b[1].units - a[1].units || a[0].localeCompare(b[0])).slice(0, THRESHOLDS.topSellers);
  if (ranked.length) {
    const all = total(last30);
    out.push({
      kind: "top_seller", severity: "info", title: `Top sellers, last 30 days: ${label(ranked[0][0], ranked[0][1].title)}`,
      summary: `${ranked.length} SKU${ranked.length > 1 ? "s" : ""} account for ${Math.round((ranked.reduce((s, [, v]) => s + v.units, 0) / all) * 100)}% of the ${all} units ordered.`,
      recommendation: "Keep these SKUs in stock and check their listing quality first; a stock-out here costs the most.",
      evidence: ranked.map(([sku, v]) => ({ metric: `Units ordered: ${label(sku, v.title)}`, value: v.units, source: SRC_ORDERS, period: period30 } satisfies Evidence)),
      dedupeKey: `top_seller:${wk}`, periodStart: iso(w30), periodEnd: iso(now),
    });
  }

  // 2. Sales trend (30 days vs the 30 before)
  const u30 = total(last30), u60 = total(prior30);
  if (u60 >= THRESHOLDS.trendMinPriorUnits) {
    const change = pct(u30, u60);
    if (Math.abs(change) >= THRESHOLDS.trendChangePct) {
      const down = change < 0;
      out.push({
        kind: "sales_trend", severity: down ? "watch" : "info", title: `Units ordered ${down ? "down" : "up"} ${Math.abs(change)}% vs the previous 30 days`,
        summary: `${u30} units in the last 30 days against ${u60} in the 30 days before.`,
        recommendation: down ? "Look for a cause (stock-outs, listing problems, seasonality) before acting; this rule cannot tell which." : "Check stock cover for the SKUs driving the rise.",
        evidence: [
          { metric: "Units ordered, last 30 days", value: u30, source: SRC_ORDERS, period: period30 },
          { metric: "Units ordered, previous 30 days", value: u60, source: SRC_ORDERS, period: `${iso(w60).slice(0, 10)} to ${iso(w30).slice(0, 10)}` },
          { metric: "Change", value: `${change}%`, source: "Computed from the two figures above" },
        ],
        dedupeKey: `sales_trend:${wk}`, periodStart: iso(w60), periodEnd: iso(now),
      });
    }
  }

  // 3. Low inventory (days of cover from FBA fulfillable stock and 30-day sales rate)
  const lows = input.inventory.filter((i) => i.source === "fba" && i.fulfillable !== null).map((i) => {
    const sold = last30.get(i.sellerSku)?.units ?? 0;
    return { i, sold, cover: sold > 0 ? (i.fulfillable as number) / (sold / 30) : null };
  }).filter((x) => x.cover !== null && x.cover < THRESHOLDS.lowCoverWatchDays).sort((a, b) => (a.cover as number) - (b.cover as number)).slice(0, THRESHOLDS.maxPerRule);
  for (const { i, sold, cover } of lows) {
    const days = Math.floor(cover as number);
    out.push({
      kind: "low_inventory", severity: (cover as number) < THRESHOLDS.lowCoverActDays ? "act" : "watch", title: `Low stock: ${label(i.sellerSku, i.productName)} has about ${days} days of cover`,
      summary: `${i.fulfillable} fulfillable units against ${sold} sold in the last 30 days.`,
      recommendation: `Consider replenishing ${i.sellerSku}${(i.inboundShipped ?? 0) + (i.inboundWorking ?? 0) + (i.inboundReceiving ?? 0) > 0 ? " (some stock is already inbound; check its arrival date)" : ""}.`,
      evidence: [
        { metric: "Fulfillable units", value: i.fulfillable as number, source: SRC_FBA, period: i.sourceUpdatedAt ?? "latest snapshot" },
        { metric: "Units ordered, last 30 days", value: sold, source: SRC_ORDERS, period: period30 },
        { metric: "Days of cover", value: days, source: "Computed: fulfillable / (units ordered / 30)" },
      ],
      dedupeKey: `low_inventory:${i.sellerSku}:${wk}`, periodStart: iso(w30), periodEnd: iso(now),
    });
  }

  // 4. Inventory risk (stock Amazon holds that cannot be sold or is being investigated)
  const risks = input.inventory.filter((i) => i.source === "fba").map((i) => ({ i, held: (i.unfulfillable ?? 0) + (i.researching ?? 0) }))
    .filter(({ i, held }) => held > 0 && (held >= THRESHOLDS.riskMinUnits || (i.totalQuantity ? (held / i.totalQuantity) * 100 >= THRESHOLDS.riskMinSharePct : false)))
    .sort((a, b) => b.held - a.held).slice(0, THRESHOLDS.maxPerRule);
  for (const { i, held } of risks) {
    out.push({
      kind: "inventory_risk", severity: "watch", title: `${held} unit${held > 1 ? "s" : ""} of ${label(i.sellerSku, i.productName)} cannot be sold right now`,
      summary: `${i.unfulfillable ?? 0} unfulfillable and ${i.researching ?? 0} under research of ${i.totalQuantity ?? "an unknown number of"} total units.`,
      recommendation: "Review why this stock is unfulfillable or under research in Seller Central; a person decides whether to request removal or reimbursement.",
      evidence: [
        { metric: "Unfulfillable units", value: i.unfulfillable ?? 0, source: SRC_FBA, period: i.sourceUpdatedAt ?? "latest snapshot" },
        { metric: "Researching units", value: i.researching ?? 0, source: SRC_FBA, period: i.sourceUpdatedAt ?? "latest snapshot" },
      ],
      dedupeKey: `inventory_risk:${i.sellerSku}:${wk}`, periodStart: null, periodEnd: iso(now),
    });
  }

  // 5. Listing issues reported by Amazon
  const flagged = input.products.filter((p) => p.issueErrorCount > 0 || p.issueWarningCount > 0)
    .sort((a, b) => b.issueErrorCount - a.issueErrorCount || b.issueWarningCount - a.issueWarningCount || a.sellerSku.localeCompare(b.sellerSku)).slice(0, THRESHOLDS.maxPerRule);
  for (const p of flagged) {
    const err = p.issueErrorCount > 0;
    out.push({
      kind: "listing_issue", severity: err ? "act" : "watch", title: `${err ? "Listing errors" : "Listing warnings"}: ${label(p.sellerSku, p.title)}`,
      summary: `Amazon reports ${p.issueErrorCount} error${p.issueErrorCount === 1 ? "" : "s"} and ${p.issueWarningCount} warning${p.issueWarningCount === 1 ? "" : "s"} on this listing.`,
      recommendation: err ? "Errors can stop a listing selling. A person should open the listing in Seller Central and fix the attributes Amazon names." : "Warnings usually reduce visibility rather than stop sales; fix when convenient.",
      evidence: [
        { metric: "Error count", value: p.issueErrorCount, source: SRC_LISTINGS },
        { metric: "Warning count", value: p.issueWarningCount, source: SRC_LISTINGS },
        ...p.issues.slice(0, 5).map((x) => ({ metric: `Amazon ${x.severity ?? "issue"} ${x.code ?? ""}`.trim(), value: x.message ?? "(no message)", source: SRC_LISTINGS } satisfies Evidence)),
      ],
      dedupeKey: `listing_issue:${p.sellerSku}:${wk}`, periodStart: null, periodEnd: iso(now),
    });
  }

  // 6. Unusual change: last 7 days' daily rate against the 28 days before that
  const w7 = now - 7 * DAY, w35 = now - 35 * DAY;
  const recent = total(unitsBySku(input.lines, w7, now + 1));
  const base = total(unitsBySku(input.lines, w35, w7));
  if (base >= THRESHOLDS.unusualMinPriorUnits) {
    const ratio = (recent / 7) / (base / 28);
    if (ratio >= THRESHOLDS.unusualHighRatio || ratio <= THRESHOLDS.unusualLowRatio) {
      const up = ratio >= THRESHOLDS.unusualHighRatio;
      out.push({
        kind: "unusual_change", severity: "watch", title: `Unusual ${up ? "spike" : "drop"}: daily units ordered are ${ratio.toFixed(1)}x the recent norm`,
        summary: `${recent} units in the last 7 days (${(recent / 7).toFixed(1)} per day) against ${(base / 28).toFixed(1)} per day over the 28 days before.`,
        recommendation: up ? "Check for a promotion, a viral order or a data duplicate before reacting." : "Check for stock-outs, listing suppression or a gap in synced orders before reacting.",
        evidence: [
          { metric: "Units ordered, last 7 days", value: recent, source: SRC_ORDERS, period: `${iso(w7).slice(0, 10)} to ${iso(now).slice(0, 10)}` },
          { metric: "Units ordered, 28 days before", value: base, source: SRC_ORDERS, period: `${iso(w35).slice(0, 10)} to ${iso(w7).slice(0, 10)}` },
          { metric: "Daily-rate ratio", value: Number(ratio.toFixed(2)), source: "Computed from the two figures above" },
        ],
        dedupeKey: `unusual_change:${wk}`, periodStart: iso(w35), periodEnd: iso(now),
      });
    }
  }
  return out;
}
