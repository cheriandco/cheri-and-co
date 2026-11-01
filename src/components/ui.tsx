/** Server-safe presentational primitives. */
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ArrowDownRight, ArrowUpRight, Gem } from "lucide-react";
import type { ThumbTone } from "@/types";

export function Butterfly({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden>
      <path d="M16 9v15M16 12c-2-5-7-7-10-5-2 2 0 7 4 8 3 1 5 0 6-3zM16 12c2-5 7-7 10-5 2 2 0 7-4 8-3 1-5 0-6-3zM15 19c-3-1-6 1-6 4 0 2 3 3 5 1 1-1 1-3 1-5zM17 19c3-1 6 1 6 4 0 2-3 3-5 1-1-1-1-3-1-5z" />
      <path d="M14 8c-1-2-2-3-3-3M18 8c1-2 2-3 3-3" />
    </svg>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow"><Butterfly size={14} />{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}

export function SectionHeader({ title, href, linkLabel = "View all", extra }: { title: string; href?: string; linkLabel?: string; extra?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {extra}
      {href && <Link href={href}>{linkLabel} <ArrowRight size={13} /></Link>}
    </div>
  );
}

export function DashboardCard({ children, flush, tint, className = "" }: { children: ReactNode; flush?: boolean; tint?: boolean; className?: string }) {
  return <section className={`card ${flush ? "flush" : ""} ${tint ? "tint" : ""} ${className}`}>{children}</section>;
}

const BADGE: Record<string, [string, string]> = {
  // content
  draft: ["", "Draft"], in_review: ["champagne", "In Review"], approved: ["sage", "Approved"],
  scheduled: ["info", "Scheduled"], published: ["rose", "Published"], rejected: ["danger", "Rejected"],
  // enquiries
  new: ["rose", "New"], ai_replied: ["info", "AI replied"], needs_human: ["champagne", "Needs human"], resolved: ["sage", "Resolved"],
  // approvals / tasks
  pending: ["champagne", "Pending review"], executed: ["sage", "Completed"], open: ["champagne", "Open"], done: ["sage", "Done"], postponed: ["", "Postponed"],
  // temperature
  HOT: ["danger", "Hot"], WARM: ["champagne", "Warm"], COLD: ["info", "Cold"],
  // priority & levels
  high: ["danger", "High"], medium: ["champagne", "Medium"], low: ["sage", "Low"],
  // listings
  live: ["sage", "Live"], needs_work: ["champagne", "Needs work"],
  positive: ["sage", "Positive"], neutral: ["", "Neutral"], negative: ["danger", "Negative"],
  // agents
  active: ["sage", "Active"], idle: ["", "Idle"], attention: ["champagne", "Needs you"],
  low_stock: ["champagne", "Low stock"],
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const [tone, text] = BADGE[status] ?? ["", status];
  return <span className={`badge ${tone}`}>{label ?? text}</span>;
}

/** Marks anything an agent "did" in this demo. Same wording on every agent page. */
export function SimBadge({ children = "SAMPLE · simulated" }: { children?: ReactNode }) {
  return <span className="badge champagne plain">{children}</span>;
}

export function Avatar({ name, size }: { name: string; size?: "sm" | "lg" }) {
  const initials = name.replace(/[^\p{L}\s]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  return <span className={`avatar ${size ?? ""}`} aria-hidden>{initials}</span>;
}

export function Thumb({ tone, size = "sm" }: { tone: ThumbTone; size?: "sm" | "lg" }) {
  return <span className={`thumb ${size} tone-${tone}`} aria-hidden><Gem size={size === "sm" ? 18 : 32} strokeWidth={1.2} /></span>;
}

export function Delta({ value }: { value: number }) {
  const cls = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const Icon = value < 0 ? ArrowDownRight : ArrowUpRight;
  return <span className={`delta ${cls}`}>{value !== 0 && <Icon size={13} />}{value > 0 ? "+" : ""}{value}%</span>;
}

export function Score({ value }: { value: number }) {
  return <span className="score num"><b style={{ fontWeight: 500 }}>{value}</b><i style={{ ["--w" as string]: `${value}%` }} /></span>;
}

export function Tabs({ base, tabs, active }: { base: string; tabs: { id: string; label: string }[]; active: string }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {tabs.map((t) => (
        <Link key={t.id} href={`${base}?tab=${t.id}`} aria-current={t.id === active ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}

export function FilterBar({ base, param, options, active, extra = {} }: { base: string; param: string; options: { id: string; label: string }[]; active: string; extra?: Record<string, string> }) {
  return (
    <div className="filters" role="group" aria-label="Filters">
      {options.map((o) => {
        const q = new URLSearchParams({ ...extra, ...(o.id === "all" ? {} : { [param]: o.id }) }).toString();
        return <Link key={o.id} className="chip" href={q ? `${base}?${q}` : base} aria-current={o.id === active}>{o.label}</Link>;
      })}
    </div>
  );
}

export interface Column<T> { header: string; cell: (row: T) => ReactNode; primary?: boolean }

export function DataTable<T extends { id: string }>({ rows, columns, empty }: { rows: T[]; columns: Column<T>[]; empty?: { title: string; hint?: string } }) {
  if (rows.length === 0) return <EmptyState title={empty?.title ?? "Nothing here yet"} hint={empty?.hint} />;
  return (
    <div className="table-wrap">
      <table className="data stack-sm">
        <thead><tr>{columns.map((c) => <th key={c.header} scope="col">{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c, i) => <td key={c.header} className={c.primary ? "primary" : ""} data-label={i === 0 ? undefined : c.header}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <Butterfly size={34} />
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function LoadingSkeleton({ rows = 4, height = 56 }: { rows?: number; height?: number }) {
  return (
    <div className="stack" style={{ gap: 12 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skel" style={{ height }} />)}
    </div>
  );
}

export function Money({ value }: { value: number }) {
  return <span className="num">₹{value.toLocaleString("en-IN")}</span>;
}
