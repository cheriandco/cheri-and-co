/** Server-rendered domain components built from the primitives. */
import Link from "next/link";
import { Sparkline } from "./charts";
import { Avatar, DataTable, Delta, EmptyState, Money, Score, StatusBadge, Thumb, type Column } from "./ui";
import type {
  Activity, Agent, AmazonRow, ContentItem, Customer, Enquiry, Kpi, Retailer,
} from "@/types";

export function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <Link href={kpi.href} className="card kpi" aria-label={`${kpi.label}: ${kpi.value}`}>
      <span className="label">{kpi.label}</span>
      <span className="value num">{kpi.value.toLocaleString("en-IN")}</span>
      <span className="row" style={{ gap: 8 }}><Delta value={kpi.change} /></span>
      <span className="cmp">{kpi.comparison}</span>
      <Sparkline data={kpi.spark} label={kpi.label} />
    </Link>
  );
}

export function AgentStatusCard({ agents }: { agents: Agent[] }) {
  return (
    <div>
      {agents.map((a) => (
        <div className="agent" key={a.key}>
          <span className={`pulse ${a.status}`} aria-hidden />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b style={{ fontWeight: 500 }}>{a.name}</b>
              <StatusBadge status={a.status} />
            </div>
            <div className="sub muted" style={{ fontSize: 12.5 }}>{a.latestAction}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{a.actionsToday} actions today · {a.lastActivity}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConversationList({ items }: { items: Enquiry[] }) {
  if (!items.length) return <EmptyState title="No enquiries yet" hint="New Instagram messages will appear here." />;
  return (
    <div className="list">
      {items.map((e) => (
        <Link key={e.id} href={`/b2c?c=${e.id}`} className="list-item">
          <Avatar name={e.customer} />
          <div className="body">
            <div className="title">{e.customer} <span className="muted" style={{ fontWeight: 400 }}>· {e.product}</span></div>
            <div className="sub">“{e.message}”</div>
          </div>
          <div className="meta">
            <span>{e.time}</span>
            <span className="row" style={{ gap: 6 }}><StatusBadge status={e.status} /><span className="badge plain">{e.handler}</span></span>
          </div>
        </Link>
      ))}
    </div>
  );
}

const retailerColumns: Column<Retailer>[] = [
  { header: "Business", primary: true, cell: (r) => <Link href={`/retailers/${r.id}`}>{r.business}<small>{r.category}</small></Link> },
  { header: "Location", cell: (r) => r.location },
  { header: "Lead score", cell: (r) => <Score value={r.score} /> },
  { header: "Temperature", cell: (r) => <StatusBadge status={r.temperature} /> },
  { header: "Status", cell: (r) => r.status },
  { header: "Last activity", cell: (r) => <span className="muted">{r.lastActivity}</span> },
];

export function RetailerTable({ rows }: { rows: Retailer[] }) {
  return <DataTable rows={rows} columns={retailerColumns} empty={{ title: "No B2B leads found.", hint: "Adjust the filters or wait for the next discovery run." }} />;
}

export function ContentList({ items }: { items: ContentItem[] }) {
  if (!items.length) return <EmptyState title="Nothing scheduled" hint="Generated content will appear here." />;
  return (
    <div className="list">
      {items.map((c) => (
        <div className="list-item" key={c.id}>
          <Thumb tone={c.tone} />
          <div className="body">
            <div className="title">{c.name}</div>
            <div className="sub">{c.platform} · {c.type}</div>
          </div>
          <div className="meta"><span>{c.date}</span><StatusBadge status={c.status} /></div>
        </div>
      ))}
    </div>
  );
}

const levelTone = (l: string) => (l === "high" ? "high" : l === "low" ? "low" : "medium");

const amazonColumns: Column<AmazonRow>[] = [
  { header: "Product", primary: true, cell: (r) => r.product },
  { header: "Demand", cell: (r) => <span className="badge plain">{r.demand}</span> },
  { header: "Competition", cell: (r) => <span className="badge plain" data-tone={levelTone(r.competition)}>{r.competition}</span> },
  { header: "Avg price", cell: (r) => <Money value={r.avgPrice} /> },
  { header: "Opportunity", cell: (r) => <Score value={r.opportunity} /> },
  { header: "Recommendation", cell: (r) => <span className="muted">{r.recommendation}</span> },
];

export function AmazonInsightTable({ rows }: { rows: AmazonRow[] }) {
  return <DataTable rows={rows} columns={amazonColumns} empty={{ title: "No Amazon insights yet" }} />;
}

export function ActivityTimeline({ items }: { items: Activity[] }) {
  if (!items.length) return <EmptyState title="No activity yet" />;
  return (
    <ul className="timeline">
      {items.map((a) => (
        <li key={a.id}>{a.text}<small>{a.actor} · {a.at}</small></li>
      ))}
    </ul>
  );
}

export function CustomerTable({ rows }: { rows: Customer[] }) {
  return (
    <DataTable rows={rows} empty={{ title: "No customers yet", hint: "Customers appear when someone enquires on Instagram." }} columns={[
      { header: "Customer", primary: true, cell: (c) => <Link href={`/customers/${c.id}`} className="row" style={{ gap: 10 }}><Avatar name={c.name} size="sm" /><span>{c.name}<small>{c.instagram}</small></span></Link> },
      { header: "City", cell: (c) => c.city },
      { header: "Interests", cell: (c) => c.interests.map((i) => <span className="tag" key={i}>{i}</span>) },
      { header: "Purchases", cell: (c) => <span className="num">{c.purchases}</span> },
      { header: "Stage", cell: (c) => <StatusBadge status={c.purchases ? "resolved" : "new"} label={c.purchases ? "Customer" : "Lead"} /> },
    ]} />
  );
}
