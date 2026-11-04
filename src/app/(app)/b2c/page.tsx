import { isLiveOrg } from "@/lib/auth/access";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { CONSENT_WARNING, KIND_LABELS, THRESHOLDS } from "@/lib/b2c-opportunities";
import type { Metadata } from "next";
import Link from "next/link";
import { getActionLinks, getB2cOpportunities, getConversations } from "@/services";
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

/** A real organisation: opportunities from its own saved customers and orders. No sample conversations, nothing is sent. */
async function LiveB2C() {
  const canQueue = can((await getAuthUser())?.role, "agents:run");
  const [opps, links] = await Promise.all([getB2cOpportunities(), getActionLinks()]);
  return (
    <div className="stack">
      <PageHeader eyebrow="B2C Sales Agent" title="B2C Sales" subtitle="Customers worth a follow-up, found from your saved orders. A person reviews and sends every message." />
      <DashboardCard tint>
        <p style={{ margin: 0, fontWeight: 500 }}>{CONSENT_WARNING}</p>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
          The app does not record whether a customer agreed to be contacted, and approving a draft is not proof that they did. Nothing is sent from here: check permission yourself, then send outside the app.
        </p>
      </DashboardCard>
      <DashboardCard>
        <SectionHeader title={`Follow-up opportunities (${opps.length})`} />
        {opps.length ? (
          <div className="list">
            {opps.map((o) => (
              <div key={o.customerId} className="list-item" style={{ alignItems: "flex-start" }}>
                <div className="body">
                  <div className="title"><Link className="link" href={`/customers/${o.customerId}`}>{o.customerName}</Link></div>
                  <div className="sub">{KIND_LABELS[o.kind]} · {o.reason}</div>
                  {o.flags.includes("contact_incomplete") && <div className="sub" style={{ color: "var(--danger)" }}>No usable email or phone recorded. Add contact details to draft a message.</div>}
                </div>
                <div className="meta">
                  {o.draftable && canQueue
                    ? <QueueButton agent="b2c" refId={o.customerId} label="Draft follow-up" link={links[`b2c:${o.customerId}`]} live />
                    : <span className="badge plain">{o.kind === "review_returned" ? "Review by a person" : o.draftable ? "View only" : "Flag only"}</span>}
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No follow-up opportunities right now" hint="Opportunities appear when customers have saved orders in the ranges below. Record or import orders under Customers." />}
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          Provisional rules, to be confirmed with the client before operational use. They look at each customer&apos;s most recent order, counted from the order date: new for more than {THRESHOLDS.unpaidAfter} days; delivered {THRESHOLDS.repeat.min} to {THRESHOLDS.repeat.max} days ago (repeat purchase); more than {THRESHOLDS.winBackAfter} days ago (win-back). Returned or cancelled orders are flagged for a person, not nudged. Post-delivery check-ins are switched off: the app records the order date, not the delivery date.
        </p>
      </DashboardCard>
    </div>
  );
}

export default async function B2CPage({ searchParams }: { searchParams: Promise<{ status?: string; c?: string }> }) {
  if (await isLiveOrg()) return <LiveB2C />;
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
