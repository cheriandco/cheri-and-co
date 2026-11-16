import { DashboardCard, DataTable, EmptyState, PageHeader, SectionHeader, StatusBadge, Tabs } from "./ui";
import { AmazonInsightSend, AmazonSyncControls } from "./amazon-sync";
import type { AmazonLiveView } from "@/lib/amazon/view";
import type { Evidence } from "@/lib/amazon/insights/rules";

export const LIVE_TABS = ["overview", "orders", "products", "inventory", "reports", "insights"].map((id) => ({ id, label: id === "insights" ? "AI Insights" : id[0].toUpperCase() + id.slice(1) }));

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never");
const money = (v: number | null, cur: string | null) => (v === null ? "n/a" : `${cur === "INR" || !cur ? "₹" : `${cur} `}${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const num = (v: number | null) => (v === null ? "n/a" : v.toLocaleString("en-IN"));

/** Live organisations only. Shows exactly one Amazon environment (set by server configuration), labels sandbox as simulated, and never mixes it with sample data.
 *  Competitors, Reviews and Pricing are deliberately absent: they have no live source and would be invented. */
export function AmazonLive({ view, tab }: { view: AmazonLiveView; tab: string }) {
  const header = <PageHeader eyebrow="Amazon Intelligence" title="Amazon intelligence" subtitle="Orders, listings, stock and rules-based insights from your Amazon India seller account. Read-only: nothing here changes anything on Amazon." />;
  if (view.state === "unconfigured") {
    return <div className="stack">{header}<DashboardCard><EmptyState title="Amazon is not connected" hint={`${view.message} Credentials are set as server environment variables; they are never entered in the browser.`} /></DashboardCard></div>;
  }
  if (view.state === "tables_missing") {
    return <div className="stack">{header}<DashboardCard><EmptyState title="Amazon tables are not installed yet" hint={view.message} /></DashboardCard></div>;
  }
  const { connection: c, overview: o, simulated } = view;
  const active = LIVE_TABS.some((t) => t.id === tab) ? tab : "overview";
  const verified = c?.status === "verified";
  const lastSync = [c?.ordersWatermark, c?.catalogSyncedAt, c?.inventorySyncedAt, c?.reportsSyncedAt].filter((x): x is string => !!x).sort().at(-1) ?? null;

  return (
    <div className="stack">
      {header}
      <p style={{ margin: 0, fontSize: 13 }} role="status">
        {simulated
          ? <><span className="badge champagne">SIMULATED · Amazon sandbox test data</span> This is Amazon&rsquo;s static test data, not your real sales. Insights from it cannot be sent for approval.</>
          : <><span className="badge sage">LIVE · Amazon production data</span> Read-only. Last synchronised: {when(lastSync)}.</>}
      </p>
      <DashboardCard>
        <div className="row" style={{ gap: 24, flexWrap: "wrap", justifyContent: "space-between" }}>
          <div style={{ fontSize: 13.5 }}>
            <div><b style={{ fontWeight: 500 }}>Marketplace</b> {c?.marketplaceName ?? "Amazon India"} · {view.marketplaceId} · {view.environment}</div>
            <div className="muted">Connection: {c ? <StatusBadge status={c.status === "verified" ? "approved" : c.status === "failed" ? "rejected" : "pending"} label={c.status} /> : "not verified yet"}{c?.verifiedAt ? ` · verified ${when(c.verifiedAt)}` : ""}</div>
            {c?.lastErrorCode && <div style={{ color: "var(--danger)", fontSize: 12.5 }}>Last problem: {c.lastErrorCode} ({when(c.lastErrorAt)})</div>}
            <div className="muted" style={{ fontSize: 12.5 }}>Synced: orders to {when(c?.ordersWatermark)} · listings {when(c?.catalogSyncedAt)} · FBA stock {when(c?.inventorySyncedAt)} · report {when(c?.reportsSyncedAt)}</div>
          </div>
          <AmazonSyncControls canSync={view.canSync} verified={verified} />
        </div>
      </DashboardCard>
      <Tabs base="/amazon" tabs={LIVE_TABS} active={active} />

      {active === "overview" && (
        <div className="stack">
          <div className="grid three">
            <DashboardCard tint><div className="muted">Units ordered, last 30 days</div><div className="serif" style={{ fontSize: 40 }}>{num(o.unitsOrdered)}</div><div className="muted" style={{ fontSize: 12 }}>{o.orderCount}{o.orderCountCapped ? "+" : ""} orders</div></DashboardCard>
            <DashboardCard tint><div className="muted">Ordered value, last 30 days</div><div className="serif" style={{ fontSize: 40 }}>{money(o.orderedValue, o.currencyCode)}</div><div className="muted" style={{ fontSize: 12 }}>Before returns, cancellations and fees. Not revenue.</div></DashboardCard>
            <DashboardCard tint><div className="muted">Listings</div><div className="serif" style={{ fontSize: 40 }}>{o.listings}</div><div className="muted" style={{ fontSize: 12 }}>{o.listingsWithErrors} with errors · FBA fulfillable {num(o.fbaFulfillableUnits)}</div></DashboardCard>
          </div>
          <DashboardCard flush>
            <div style={{ padding: "22px 22px 0" }}><SectionHeader title="Top SKUs, last 30 days" /></div>
            <DataTable rows={o.topSkus.map((t) => ({ id: t.sku, ...t }))} empty={{ title: "No orders synced yet", hint: "Verify the connection, then Sync now." }} columns={[
              { header: "SKU", primary: true, cell: (r) => <>{r.title ?? r.sku}<small>{r.sku}</small></> },
              { header: "Units", cell: (r) => <span className="num">{r.units}</span> },
            ]} />
          </DashboardCard>
          <DashboardCard flush>
            <div style={{ padding: "22px 22px 0" }}><SectionHeader title="Recent sync runs" /></div>
            <DataTable rows={view.runs} empty={{ title: "No sync has run yet" }} columns={[
              { header: "Kind", primary: true, cell: (r) => r.kind },
              { header: "Status", cell: (r) => <StatusBadge status={r.status === "succeeded" ? "approved" : r.status === "failed" ? "rejected" : "pending"} label={r.status} /> },
              { header: "Started", cell: (r) => when(r.startedAt) },
              { header: "Detail", cell: (r) => <span className="muted">{r.errorMessage ?? Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(", ")}</span> },
            ]} />
          </DashboardCard>
        </div>
      )}

      {active === "orders" && (
        <DashboardCard flush>
          <DataTable rows={view.orders.map((r) => ({ ...r, id: r.amazonOrderId }))} empty={{ title: "No orders synced yet" }} columns={[
            { header: "Amazon order", primary: true, cell: (r) => r.amazonOrderId },
            { header: "Ordered", cell: (r) => when(r.createdTime) },
            { header: "Status", cell: (r) => r.fulfillmentStatus },
            { header: "Units", cell: (r) => <span className="num">{r.unitCount}</span> },
            { header: "Ordered value", cell: (r) => <span className="num">{money(r.orderedValue, r.currencyCode)}</span> },
          ]} />
          <p className="muted" style={{ fontSize: 12, padding: "0 22px 16px" }}>No customer names, addresses or contact details are requested from Amazon or stored.</p>
        </DashboardCard>
      )}

      {active === "products" && (
        <DashboardCard flush>
          <DataTable rows={view.products.map((p) => ({ ...p, id: p.sellerSku }))} empty={{ title: "No listings synced yet" }} columns={[
            { header: "Listing", primary: true, cell: (r) => <>{r.title ?? r.sellerSku}<small>{r.sellerSku}{r.asin ? ` · ${r.asin}` : ""}</small></> },
            { header: "Brand", cell: (r) => r.brand ?? "n/a" },
            { header: "Status", cell: (r) => r.listingStatus.join(", ") || "n/a" },
            { header: "Price", cell: (r) => <span className="num">{money(r.price, r.currencyCode)}</span> },
            { header: "Issues", cell: (r) => (r.issueErrorCount || r.issueWarningCount ? <span style={{ color: r.issueErrorCount ? "var(--danger)" : undefined }}>{r.issueErrorCount} errors · {r.issueWarningCount} warnings</span> : <span className="muted">None reported</span>) },
            { header: "Best-seller rank", cell: (r) => (r.salesRank?.[0] ? `#${r.salesRank[0].rank.toLocaleString("en-IN")} ${r.salesRank[0].title ?? ""}` : "n/a") },
          ]} />
        </DashboardCard>
      )}

      {active === "inventory" && (
        <DashboardCard flush>
          <DataTable rows={view.inventory.map((i) => ({ ...i, id: `${i.sellerSku}:${i.source}` }))} empty={{ title: "No inventory synced yet" }} columns={[
            { header: "SKU", primary: true, cell: (r) => <>{r.productName ?? r.sellerSku}<small>{r.sellerSku}</small></> },
            { header: "Source", cell: (r) => (r.source === "fba" ? "FBA (Amazon holds it)" : "Listing quantity (you hold it)") },
            { header: "Fulfillable", cell: (r) => <span className="num">{num(r.fulfillable)}</span> },
            { header: "Inbound", cell: (r) => <span className="num">{num((r.inboundWorking ?? 0) + (r.inboundShipped ?? 0) + (r.inboundReceiving ?? 0))}</span> },
            { header: "Unfulfillable", cell: (r) => <span className="num">{num(r.unfulfillable)}</span> },
            { header: "Updated", cell: (r) => when(r.sourceUpdatedAt) },
          ]} />
        </DashboardCard>
      )}

      {active === "reports" && (
        <DashboardCard flush>
          <DataTable rows={view.reports.map((r) => ({ ...r, id: r.amazonReportId }))} empty={{ title: "No report fetched yet" }} columns={[
            { header: "Report", primary: true, cell: (r) => <>{r.reportType}<small>{r.amazonReportId}</small></> },
            { header: "Status", cell: (r) => r.status },
            { header: "Rows", cell: (r) => <span className="num">{num(r.rowCount)}</span> },
            { header: "In stock / out", cell: (r) => <span className="num">{num((r.summary.inStock as number | null) ?? null)} / {num((r.summary.outOfStock as number | null) ?? null)}</span> },
            { header: "Missing price", cell: (r) => <span className="num">{num((r.summary.missingPrice as number | null) ?? null)}</span> },
            { header: "Fetched", cell: (r) => when(r.fetchedAt) },
          ]} />
          <p className="muted" style={{ fontSize: 12, padding: "0 22px 16px" }}>Only summary counts are kept. The report file itself is not stored.</p>
        </DashboardCard>
      )}

      {active === "insights" && (
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Rule-based insights (no AI): each one lists the figures it came from. Sending one to approval records a decision only; nothing is changed on Amazon. Thresholds are provisional until reviewed against real sales.</p>
          {view.insights.length === 0 && <DashboardCard><EmptyState title="No insights yet" hint="Sync your data, then choose Refresh insights." /></DashboardCard>}
          {view.insights.map((i) => (
            <DashboardCard key={i.id}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ maxWidth: 720 }}>
                  <div className="eyebrow">{i.kind.replace(/_/g, " ")} · {i.severity}</div>
                  <div className="serif" style={{ fontSize: 20 }}>{i.title}</div>
                  <div style={{ fontSize: 13.5, marginTop: 4 }}>{i.summary}</div>
                  <div style={{ fontSize: 13.5, marginTop: 4 }}><b style={{ fontWeight: 500 }}>Suggested for a person:</b> {i.recommendation}</div>
                  <details style={{ marginTop: 8 }}><summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>Evidence ({(i.evidence as Evidence[]).length})</summary>
                    <ul className="muted" style={{ fontSize: 12.5 }}>{(i.evidence as Evidence[]).map((e, n) => <li key={n}>{e.metric}: {String(e.value)} <small>({e.source}{e.period ? `, ${e.period}` : ""})</small></li>)}</ul>
                  </details>
                </div>
                <AmazonInsightSend id={i.id} status={i.status} simulated={simulated} canQueue={view.canQueue} />
              </div>
            </DashboardCard>
          ))}
        </div>
      )}
    </div>
  );
}
