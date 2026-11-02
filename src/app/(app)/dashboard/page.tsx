import { Suspense } from "react";
import type { Metadata } from "next";
import { getCurrentUser, getDashboardSummary, getOrchestratorBrief } from "@/services";
import { isLiveOrg } from "@/lib/auth/access";
import { OrchestratorCard } from "@/components/agent-views";
import { PageHeader, SectionHeader, DashboardCard } from "@/components/ui";
import { KpiCard, AgentStatusCard, ConversationList, RetailerTable, ContentList, AmazonInsightTable } from "@/components/domain";
import { PipelineFunnel, TrendChart } from "@/components/charts";
import { ApprovalQueue, RangeSelect, TaskList } from "@/components/interactive";

export const metadata: Metadata = { title: "Dashboard" };

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range } = await searchParams;
  const [user, d, brief, live] = await Promise.all([getCurrentUser(), getDashboardSummary(range), getOrchestratorBrief(), isLiveOrg()]);

  return (
    <div className="stack" style={{ gap: 28 }}>
      <PageHeader
        eyebrow="Overview"
        title={`${greeting()}, ${user.name}`}
        subtitle="Here’s what’s happening with your business today."
        actions={<Suspense fallback={null}><RangeSelect /></Suspense>}
      />

      {!live && (
      <section className="grid kpis" aria-label="Key metrics">
        {d.kpis.map((k) => <KpiCard key={k.id} kpi={k} />)}
      </section>

      )}

      <OrchestratorCard brief={brief} />

      {!live && (
        <>
      <div className="grid two">
        <DashboardCard>
          <SectionHeader title="Enquiries & leads" />
          <TrendChart series={d.trend} />
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="Sales pipeline" href="/crm?tab=pipeline" linkLabel="Open board" />
          <PipelineFunnel stages={d.funnel} />
        </DashboardCard>
      </div>

      <div className="grid two">
        <DashboardCard>
          <SectionHeader title="Recent Instagram enquiries" href="/b2c" />
          <ConversationList items={d.enquiries} />
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="Agent activity" />
          <AgentStatusCard agents={d.agents} />
        </DashboardCard>
      </div>

        </>
      )}

      <section>
        <SectionHeader title="Awaiting your approval" href="/approvals" />
        <ApprovalQueue initial={d.approvals} compact />
      </section>

      {!live && (
        <>
      <DashboardCard flush>
        <div style={{ padding: "22px 22px 0" }}><SectionHeader title="B2B retailer leads" href="/b2b" /></div>
        <RetailerTable rows={d.retailers} />
      </DashboardCard>

      <div className="grid even">
        <DashboardCard>
          <SectionHeader title="Content calendar" href="/content?tab=calendar" />
          <ContentList items={d.content} />
        </DashboardCard>
        <DashboardCard flush>
          <div style={{ padding: "22px 22px 0" }}><SectionHeader title="Amazon intelligence" href="/amazon" /></div>
          <AmazonInsightTable rows={d.amazon} />
        </DashboardCard>
      </div>

        </>
      )}

      <section>
        <SectionHeader title="Tasks & follow-ups" href="/tasks" />
        <TaskList initial={d.tasks} live={live} />
      </section>
    </div>
  );
}
