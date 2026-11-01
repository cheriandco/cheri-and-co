import { isLiveOrg } from "@/lib/auth/access";
import { NotConnected } from "@/components/not-connected";
import type { Metadata } from "next";
import Link from "next/link";
import { getActionLinks, getConversations } from "@/services";
import { classifyIntent } from "@/lib/b2c-agent";
import { suggestedReplyFor } from "@/lib/agent-logic";
import { QueueButton } from "@/components/agent-actions";
import { PageHeader, DashboardCard, SectionHeader, FilterBar, EmptyState, Avatar, StatusBadge, SimBadge } from "@/components/ui";
import { ConversationList } from "@/components/domain";
import { B2CAgentPanel } from "@/components/b2c-agent-panel";

export const metadata: Metadata = { title: "B2C Sales" };

const OPTIONS = [
  { id: "all", label: "All" }, { id: "new", label: "New" }, { id: "ai_replied", label: "AI replied" },
  { id: "needs_human", label: "Needs human" }, { id: "resolved", label: "Resolved" },
];

export default async function B2CPage({ searchParams }: { searchParams: Promise<{ status?: string; c?: string }> }) {
  if (await isLiveOrg()) return <NotConnected title="B2C Sales" />;
  const { status = "all", c } = await searchParams;
  const [all, links] = await Promise.all([getConversations(), getActionLinks()]);
  const rows = status === "all" ? all : all.filter((e) => e.status === status);
  const selected = all.find((e) => e.id === c) ?? rows[0];
  const intent = selected ? classifyIntent(selected.message) : null;

  return (
    <div className="stack">
      <PageHeader eyebrow="B2C Sales Agent" title="B2C Sales" subtitle="Instagram enquiries answered by your AI sales agent, with human handover when it matters." />
      <B2CAgentPanel />
      <FilterBar base="/b2c" param="status" options={OPTIONS} active={status} />
      <div className="grid two">
        <DashboardCard>
          <SectionHeader title={`Enquiries (${rows.length})`} extra={<SimBadge>SAMPLE conversations</SimBadge>} />
          {rows.length ? <ConversationList items={rows} /> : <EmptyState title="No enquiries match this filter" hint="Try another status." />}
        </DashboardCard>
        <DashboardCard>
          {selected ? (
            <>
              <div className="row" style={{ marginBottom: 14 }}>
                <Avatar name={selected.customer} />
                <div style={{ flex: 1 }}>
                  <b style={{ fontWeight: 500 }}>{selected.customer}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>{selected.handle} · {selected.product}</div>
                </div>
                <StatusBadge status={selected.status} />
              </div>
              {selected.messages.map((m) => (
                <div key={m.id} className={`bubble ${m.from === "customer" ? "" : "out"}`}>
                  {m.text}<div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{m.from === "customer" ? "Customer" : m.from === "ai" ? "AI draft" : "Team"} · {m.time}</div>
                </div>
              ))}
              <div style={{ marginTop: 16 }}>
                <div className="eyebrow">Suggested reply (simulated, not sent)</div>
                <div className="bubble out" style={{ maxWidth: "100%", whiteSpace: "pre-wrap" }}>{suggestedReplyFor(selected)}</div>
                <p className="muted" style={{ fontSize: 12, margin: "6px 0 10px" }}>
                  Intent: {intent?.intent.replace(/_/g, " ")} ({Math.round((intent?.confidence ?? 0) * 100)}%, rule-based). Related product: {selected.product}.
                </p>
                <QueueButton agent="b2c" refId={selected.id} label="Send reply to approval (demo)" link={links[`b2c:${selected.id}`]} />
              </div>
              <p style={{ marginTop: 14 }}><Link className="link" href={`/customers/${selected.customerId}`}>Open customer record</Link></p>
            </>
          ) : <EmptyState title="Select a conversation" />}
        </DashboardCard>
      </div>
    </div>
  );
}
