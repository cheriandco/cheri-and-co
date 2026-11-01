import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import { getActionLinks, getActivities, getDashboardSummary, getDiscovery, getRetailers } from "@/services";
import { followUpFor } from "@/lib/agent-logic";
import { DiscoveryPanel, QueueButton } from "@/components/agent-actions";
import { PageHeader, DashboardCard, SectionHeader, FilterBar, SimBadge, StatusBadge } from "@/components/ui";
import { ActivityTimeline, RetailerTable } from "@/components/domain";
import { PipelineFunnel } from "@/components/charts";

export const metadata: Metadata = { title: "B2B Leads" };

const OPTIONS = [{ id: "all", label: "All" }, { id: "HOT", label: "Hot" }, { id: "WARM", label: "Warm" }, { id: "COLD", label: "Cold" }];

export default async function B2BPage({ searchParams }: { searchParams: Promise<{ temp?: string }> }) {
  const live = await isLiveOrg();
  const { temp = "all" } = await searchParams;
  const [all, summary, discovery, links, activity] = await Promise.all([getRetailers(), getDashboardSummary(), getDiscovery(), getActionLinks(), getActivities()]);
  const focus = all.filter((r) => r.stage !== "won" && r.stage !== "lost").sort((a, b) => b.score - a.score).slice(0, 4);
  const rows = temp === "all" ? all : all.filter((r) => r.temperature === temp);

  return (
    <div className="stack">
      <PageHeader eyebrow="B2B Lead Agent" title="B2B Leads" subtitle="Retailers discovered and qualified by your lead agent, ranked by fit." />
      {!live && <DiscoveryPanel note={discovery.note} candidates={discovery.candidates} />}
      <div className="grid two">
        <DashboardCard flush>
          <div style={{ padding: "22px 22px 0" }}>
            <SectionHeader title={`Retailer leads (${rows.length})`} />
            <FilterBar base="/b2b" param="temp" options={OPTIONS} active={temp} />
          </div>
          <RetailerTable rows={rows} />
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="Pipeline" href="/crm?tab=pipeline" linkLabel="Open board" />
          <PipelineFunnel stages={summary.funnel} />
        </DashboardCard>
      </div>
      <div className="grid even">
        {!live && (
        <DashboardCard>
          <SectionHeader title="Follow-up recommendations" extra={<SimBadge>SAMPLE · rule-based</SimBadge>} />
          <div className="list">
            {focus.map((r) => {
              const f = followUpFor(r);
              return (
                <div key={r.id} className="list-item" style={{ alignItems: "flex-start" }}>
                  <div className="body">
                    <div className="title">{f.title}</div>
                    <div className="sub" style={{ whiteSpace: "normal" }}>{r.business} · {f.reason}</div>
                  </div>
                  <div className="meta"><StatusBadge status={r.temperature} /><QueueButton agent="b2b" refId={r.id} label="Draft follow-up (demo)" link={links[`b2b:${r.id}`]} /></div>
                </div>
              );
            })}
          </div>
        </DashboardCard>
        )}
        <DashboardCard>
          <SectionHeader title="Sales activity" href="/crm?tab=activities" />
          <ActivityTimeline items={activity.filter((a) => a.agent === "b2b" || a.agent === "crm" || a.actor.startsWith("B2B")).slice(0, 6)} />
        </DashboardCard>
      </div>
    </div>
  );
}
