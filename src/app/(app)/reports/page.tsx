import { isLiveOrg } from "@/lib/auth/access";
import { NotConnected } from "@/components/not-connected";
import type { Metadata } from "next";
import { getReports } from "@/services";
import { PageHeader, Tabs, DashboardCard, SectionHeader, Delta, DataTable } from "@/components/ui";
import { BarChart } from "@/components/charts";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (await isLiveOrg()) return <NotConnected title="Reports" />;
  const reports = await getReports();
  const { tab = reports[0].id } = await searchParams;
  const r = reports.find((x) => x.id === tab) ?? reports[0];

  return (
    <div className="stack">
      <PageHeader eyebrow="Insights" title="Reports" subtitle="Six weeks at a glance, by area of the business." />
      <Tabs base="/reports" tabs={reports.map((x) => ({ id: x.id, label: x.label }))} active={r.id} />
      <div className="grid three">
        {r.metrics.map((m) => (
          <DashboardCard key={m.label} tint><div className="muted">{m.label}</div><div className="serif" style={{ fontSize: 38 }}>{m.value}</div><Delta value={m.change} /></DashboardCard>
        ))}
      </div>
      <div className="grid two">
        <DashboardCard><SectionHeader title={r.seriesTitle} /><BarChart data={r.series} title={r.seriesTitle} /></DashboardCard>
        <DashboardCard flush>
          <div style={{ padding: "22px 22px 0" }}><SectionHeader title="Data" /></div>
          <DataTable rows={r.series.map((s) => ({ id: s.label, ...s }))} columns={[
            { header: "Period", primary: true, cell: (s) => s.label },
            { header: "Value", cell: (s) => <span className="num">{s.value.toLocaleString("en-IN")}</span> },
          ]} />
        </DashboardCard>
      </div>
    </div>
  );
}
