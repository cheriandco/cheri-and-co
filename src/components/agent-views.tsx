import Link from "next/link";
import { DashboardCard, EmptyState, SectionHeader, SimBadge, StatusBadge } from "./ui";
import { SuggestionTaskButton } from "./agent-actions";
import { ActivityTimeline } from "./domain";
import { AGENT_NAMES } from "@/lib/agents";
import type { Factor, Suggestion } from "@/lib/agent-logic";
import type { OrchestratorBrief } from "@/services";

/** The AI Business Orchestrator: one cross-agent summary. It reads and recommends only; people decide. */
export function OrchestratorCard({ brief }: { brief: OrchestratorBrief }) {
  const { totals } = brief;
  return (
    <DashboardCard>
      <SectionHeader title="AI Business Orchestrator" extra={<SimBadge>SAMPLE data · recommends only</SimBadge>} />
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        One view across all five agents. {totals.pending} item{totals.pending === 1 ? "" : "s"} waiting for your approval, {totals.openTasks} open tasks, {totals.hotLeads} hot leads.
        Agents only draft and suggest. Nothing happens until you approve it, and in this demo nothing is sent anywhere.
      </p>
      <div className="grid even" style={{ marginTop: 16 }}>
        <div>
          <div className="eyebrow">Agents today</div>
          <div className="list">
            {brief.agents.map((a) => (
              <Link key={a.key} href={a.href} className="list-item">
                <div className="body">
                  <div className="title">{a.name}</div>
                  <div className="sub">{a.headline}</div>
                </div>
                <div className="meta">{a.pending > 0 ? <span className="badge champagne">{a.pending} pending</span> : <span className="badge plain">Nothing pending</span>}</div>
              </Link>
            ))}
          </div>
        </div>
        <div>
          <div className="eyebrow">Recommended next actions</div>
          {brief.recommendations.length ? (
            <div className="list">
              {brief.recommendations.map((r) => (
                <Link key={r.key} href={r.href} className="list-item">
                  <div className="body">
                    <div className="title">{r.title}</div>
                    <div className="sub">{AGENT_NAMES[r.agent]} · {r.reason}</div>
                  </div>
                  <div className="meta"><StatusBadge status={r.priority} /></div>
                </Link>
              ))}
            </div>
          ) : <EmptyState title="Nothing to recommend" hint="Everything is up to date." />}
        </div>
      </div>
      <div style={{ marginTop: 18 }}>
        <div className="eyebrow">Latest activity across agents</div>
        <ActivityTimeline items={brief.feed} />
      </div>
    </DashboardCard>
  );
}

/** Suggested next actions, each turned into a task with one click (simulated, private to this visitor). */
export function SuggestionList({ items }: { items: Suggestion[] }) {
  if (!items.length) return <EmptyState title="No suggestions right now" hint="You are up to date." />;
  return (
    <div className="list">
      {items.map((s) => (
        <div key={s.key} className="list-item">
          <div className="body">
            <div className="title"><Link href={s.href}>{s.title}</Link></div>
            <div className="sub" style={{ whiteSpace: "normal" }}>{AGENT_NAMES[s.agent]} · {s.reason}</div>
          </div>
          <div className="meta"><StatusBadge status={s.priority} /><SuggestionTaskButton sugKey={s.key} /></div>
        </div>
      ))}
    </div>
  );
}

export function FactorList({ factors }: { factors: Factor[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
      {factors.map((f) => <li key={f.label}>{f.ok ? "✓" : "✗"} <b style={{ fontWeight: 500 }}>{f.label}</b> <span className="muted">· {f.note}</span></li>)}
    </ul>
  );
}
