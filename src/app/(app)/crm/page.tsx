import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import Link from "next/link";
import { getActivities, getConversations, getCustomers, getDeals, getRetailers, getSuggestions, getTasks } from "@/services";
import { SuggestionList } from "@/components/agent-views";
import { PageHeader, Tabs, DashboardCard, SectionHeader, SimBadge } from "@/components/ui";
import { ActivityTimeline, ConversationList, CustomerTable, RetailerTable } from "@/components/domain";
import { PipelineBoard, TaskList } from "@/components/interactive";

export const metadata: Metadata = { title: "CRM & Sales Ops" };

const TABS = ["overview", "customers", "leads", "retailers", "conversations", "pipeline", "tasks", "activities"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));

export default async function CrmPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "overview" } = await searchParams;

  return (
    <div className="stack">
      <PageHeader eyebrow="CRM & Sales Operations Agent" title="CRM & sales ops" subtitle="One shared record for every customer, lead and retailer. All five agents read and write here." />
      <Tabs base="/crm" tabs={TABS} active={tab} />
      {tab === "overview" && <CrmOverview />}
      {tab === "customers" && <DashboardCard flush><CustomerTable rows={await getCustomers()} /></DashboardCard>}
      {(tab === "leads" || tab === "retailers") && <DashboardCard flush><RetailerTable rows={await getRetailers()} /></DashboardCard>}
      {tab === "conversations" && <DashboardCard><ConversationList items={await getConversations()} /></DashboardCard>}
      {tab === "pipeline" && <PipelineBoard initial={await getDeals()} />}
      {tab === "tasks" && <TaskList initial={await getTasks()} />}
      {tab === "activities" && <DashboardCard><ActivityTimeline items={await getActivities()} /></DashboardCard>}
    </div>
  );
}

async function CrmOverview() {
  const [suggestions, deals, tasks, activities] = await Promise.all([getSuggestions(), getDeals(), getTasks(), getActivities()]);
  const live = await isLiveOrg();
  const open = tasks.filter((t) => t.status === "open");
  const byStage = ["new", "qualified", "contacted", "interested", "negotiation", "won"].map((st) => [st, deals.filter((d) => d.stage === st).length] as const);
  return (
    <div className="stack">
      <div className="grid three">
        <DashboardCard tint><div className="muted">Open tasks</div><div className="serif" style={{ fontSize: 40 }}>{open.length}</div><div className="muted" style={{ fontSize: 12 }}>{open.filter((t) => t.priority === "high").length} high priority</div></DashboardCard>
        <DashboardCard tint><div className="muted">Deals in pipeline</div><div className="serif" style={{ fontSize: 40 }}>{deals.filter((d) => d.stage !== "won" && d.stage !== "lost").length}</div><div className="muted" style={{ fontSize: 12 }}>{byStage.map(([st, n]) => `${st} ${n}`).join(" · ")}</div></DashboardCard>
        {!live && <DashboardCard tint><div className="muted">Sales reports</div><div style={{ marginTop: 10 }}><Link className="btn sm" href="/reports">Open reports</Link></div><div className="muted" style={{ fontSize: 12, marginTop: 8 }}>SAMPLE figures, no live sales data.</div></DashboardCard>}
      </div>
      <div className="grid even">
        <DashboardCard>
          <SectionHeader title="Suggested next actions" extra={<SimBadge>{live ? "Rule-based" : "SAMPLE · rule-based"}</SimBadge>} />
          <SuggestionList items={suggestions} />
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="Recent activity" href="/crm?tab=activities" />
          <ActivityTimeline items={activities.slice(0, 7)} />
        </DashboardCard>
      </div>
    </div>
  );
}
