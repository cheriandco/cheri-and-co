import type { Metadata } from "next";
import { getActionLinks, getAmazon } from "@/services";
import { pricePosition } from "@/lib/agent-logic";
import { QueueButton } from "@/components/agent-actions";
import { PageHeader, Tabs, DashboardCard, DataTable, SectionHeader, Money, Score, SimBadge, StatusBadge } from "@/components/ui";
import { AmazonInsightTable } from "@/components/domain";

export const metadata: Metadata = { title: "Amazon Intelligence" };

const TABS = ["overview", "products", "competitors", "reviews", "pricing", "opportunities", "listings", "recommendations"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));

export default async function AmazonPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "overview" } = await searchParams;
  const [a, links] = await Promise.all([getAmazon(), getActionLinks()]);
  const top = [...a.rows].sort((x, y) => y.opportunity - x.opportunity);
  const ourPriceFor = (rank: string) => a.pricing.find((p) => (/Necklace/i.test(rank) && /Necklace/i.test(p.product)) || (/Earring/i.test(rank) && /Earring/i.test(p.product)) || (/Anklet/i.test(rank) && /Anklet/i.test(p.product)))?.ourPrice;
  const themes = [...a.reviews.reduce((m, r) => m.set(r.theme, [...(m.get(r.theme) ?? []), r]), new Map<string, typeof a.reviews>())];

  return (
    <div className="stack">
      <PageHeader eyebrow="Amazon Intelligence Agent" title="Amazon intelligence" subtitle="Demand, competition and pricing signals — turned into recommendations you can act on." />
      <Tabs base="/amazon" tabs={TABS} active={tab} />
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}><SimBadge>SAMPLE data · not connected to Amazon</SimBadge> Listings, competitors, reviews and prices on this page are invented for the demo. Recommendations are rule-based, and any action waits for your approval.</p>

      {tab === "overview" && (
        <div className="stack">
          <div className="grid three">
            <DashboardCard tint><div className="muted">Open opportunities</div><div className="serif" style={{ fontSize: 40 }}>18</div></DashboardCard>
            <DashboardCard tint><div className="muted">Average opportunity score</div><div className="serif" style={{ fontSize: 40 }}>{Math.round(a.rows.reduce((s, r) => s + r.opportunity, 0) / a.rows.length)}</div></DashboardCard>
            <DashboardCard tint><div className="muted">Pricing gaps flagged</div><div className="serif" style={{ fontSize: 40 }}>{a.pricing.length}</div></DashboardCard>
          </div>
          <DashboardCard flush><div style={{ padding: "22px 22px 0" }}><SectionHeader title="Top opportunities" /></div><AmazonInsightTable rows={top} /></DashboardCard>
        </div>
      )}

      {(tab === "products" || tab === "opportunities") && (
        <DashboardCard flush><AmazonInsightTable rows={tab === "opportunities" ? top.filter((r) => r.opportunity >= 60) : a.rows} /></DashboardCard>
      )}

      {tab === "competitors" && (
        <DashboardCard flush>
          <DataTable rows={a.competitors} columns={[
            { header: "Brand", primary: true, cell: (r) => <>{r.brand}<small>{r.asin}</small></> },
            { header: "Price", cell: (r) => <Money value={r.price} /> },
            { header: "Rating", cell: (r) => <span className="num">{r.rating} ★</span> },
            { header: "Reviews", cell: (r) => <span className="num">{r.reviews.toLocaleString("en-IN")}</span> },
            { header: "Best-seller rank", cell: (r) => r.rank },
            { header: "Vs our price", cell: (r) => {
              const ours = ourPriceFor(r.rank);
              if (!ours) return <span className="muted">No comparable product</span>;
              const d = r.price - ours;
              return <span className="num">{d === 0 ? "Same" : `${d > 0 ? "+" : "−"}₹${Math.abs(d)}`} <span className="muted">(ours ₹{ours})</span></span>;
            } },
          ]} />
        </DashboardCard>
      )}

      {tab === "reviews" && (
        <div className="stack">
        <DashboardCard>
          <SectionHeader title="Review intelligence" extra={<SimBadge>SAMPLE · rule-based</SimBadge>} />
          <div className="grid even">
            {themes.map(([theme, rs]) => {
              const neg = rs.filter((r) => r.sentiment === "negative").length;
              const pos = rs.filter((r) => r.sentiment === "positive").length;
              return (
                <div key={theme} className="card" style={{ padding: 14, boxShadow: "none" }}>
                  <div className="eyebrow">{theme}</div>
                  <div style={{ fontSize: 13.5 }}>{pos} positive · {neg} negative · {rs.length - pos - neg} neutral</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{neg ? `Watch-out: customers raise ${theme.toLowerCase()} problems.` : pos ? `Strength: customers praise ${theme.toLowerCase()}.` : `Opportunity: improve ${theme.toLowerCase()}.`}</div>
                </div>
              );
            })}
          </div>
        </DashboardCard>
        <DashboardCard flush>
          <DataTable rows={a.reviews} columns={[
            { header: "Product", primary: true, cell: (r) => r.product },
            { header: "Rating", cell: (r) => <span className="num">{r.rating} ★</span> },
            { header: "Theme", cell: (r) => r.theme },
            { header: "Sentiment", cell: (r) => <StatusBadge status={r.sentiment} /> },
            { header: "Excerpt", cell: (r) => <span className="muted">“{r.excerpt}”</span> },
          ]} />
        </DashboardCard>
        </div>
      )}

      {tab === "pricing" && (
        <DashboardCard flush>
          <DataTable rows={a.pricing} columns={[
            { header: "Product", primary: true, cell: (r) => r.product },
            { header: "Our price", cell: (r) => <Money value={r.ourPrice} /> },
            { header: "Market range", cell: (r) => <span className="num">₹{r.marketLow} – ₹{r.marketHigh}</span> },
            { header: "Suggested", cell: (r) => <b style={{ fontWeight: 500, color: "var(--rose-ink)" }}><Money value={r.suggested} /></b> },
            { header: "Our position", cell: (r) => { const p = pricePosition(r.ourPrice, r.marketLow, r.marketHigh); return <span>{p.label} <span className="muted">({p.pct}% of range)</span></span>; } },
            { header: "Insight", cell: (r) => <span className="muted">{r.suggested < r.ourPrice ? `Lower by ₹${r.ourPrice - r.suggested} to sit nearer the market middle.` : "Holding the current price."}</span> },
          ]} />
        </DashboardCard>
      )}

      {tab === "listings" && (
        <DashboardCard flush>
          <DataTable rows={a.listings} columns={[
            { header: "Product", primary: true, cell: (r) => <>{r.product}<small>{r.asin}</small></> },
            { header: "Title quality", cell: (r) => <Score value={r.titleScore} /> },
            { header: "Image quality", cell: (r) => <Score value={r.imageScore} /> },
            { header: "Status", cell: (r) => <StatusBadge status={r.status} label={r.status === "draft" ? "Draft" : undefined} /> },
          ]} />
        </DashboardCard>
      )}

      {tab === "recommendations" && (
        <div className="stack" style={{ gap: 12 }}>
          {top.map((r) => (
            <DashboardCard key={r.id}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div><div className="eyebrow">{r.product}</div><div className="serif" style={{ fontSize: 22 }}>{r.recommendation}</div></div>
                <Score value={r.opportunity} />
              </div>
              <div style={{ marginTop: 12 }}><QueueButton agent="amazon" refId={r.id} label="Send to approval (demo)" link={links[`amazon:${r.id}`]} /></div>
            </DashboardCard>
          ))}
        </div>
      )}
    </div>
  );
}
