import type { Metadata } from "next";
import { getAmazon } from "@/services";
import { PageHeader, Tabs, DashboardCard, DataTable, SectionHeader, Money, Score, StatusBadge } from "@/components/ui";
import { AmazonInsightTable } from "@/components/domain";

export const metadata: Metadata = { title: "Amazon Intelligence" };

const TABS = ["overview", "products", "competitors", "reviews", "pricing", "opportunities", "listings", "recommendations"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));

export default async function AmazonPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "overview" } = await searchParams;
  const a = await getAmazon();
  const top = [...a.rows].sort((x, y) => y.opportunity - x.opportunity);

  return (
    <div className="stack">
      <PageHeader eyebrow="Amazon Intelligence Agent" title="Amazon intelligence" subtitle="Demand, competition and pricing signals — turned into recommendations you can act on." />
      <Tabs base="/amazon" tabs={TABS} active={tab} />

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
          ]} />
        </DashboardCard>
      )}

      {tab === "reviews" && (
        <DashboardCard flush>
          <DataTable rows={a.reviews} columns={[
            { header: "Product", primary: true, cell: (r) => r.product },
            { header: "Rating", cell: (r) => <span className="num">{r.rating} ★</span> },
            { header: "Theme", cell: (r) => r.theme },
            { header: "Sentiment", cell: (r) => <StatusBadge status={r.sentiment} /> },
            { header: "Excerpt", cell: (r) => <span className="muted">“{r.excerpt}”</span> },
          ]} />
        </DashboardCard>
      )}

      {tab === "pricing" && (
        <DashboardCard flush>
          <DataTable rows={a.pricing} columns={[
            { header: "Product", primary: true, cell: (r) => r.product },
            { header: "Our price", cell: (r) => <Money value={r.ourPrice} /> },
            { header: "Market range", cell: (r) => <span className="num">₹{r.marketLow} – ₹{r.marketHigh}</span> },
            { header: "Suggested", cell: (r) => <b style={{ fontWeight: 500, color: "var(--rose-ink)" }}><Money value={r.suggested} /></b> },
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
            </DashboardCard>
          ))}
        </div>
      )}
    </div>
  );
}
