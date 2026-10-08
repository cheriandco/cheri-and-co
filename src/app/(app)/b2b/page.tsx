import type { Metadata } from "next";
import { getDashboardSummary, getRetailers } from "@/services";
import { PageHeader, DashboardCard, SectionHeader, FilterBar } from "@/components/ui";
import { RetailerTable } from "@/components/domain";
import { PipelineFunnel } from "@/components/charts";

export const metadata: Metadata = { title: "B2B Leads" };

const OPTIONS = [{ id: "all", label: "All" }, { id: "HOT", label: "Hot" }, { id: "WARM", label: "Warm" }, { id: "COLD", label: "Cold" }];

export default async function B2BPage({ searchParams }: { searchParams: Promise<{ temp?: string }> }) {
  const { temp = "all" } = await searchParams;
  const [all, summary] = await Promise.all([getRetailers(), getDashboardSummary()]);
  const rows = temp === "all" ? all : all.filter((r) => r.temperature === temp);

  return (
    <div className="stack">
      <PageHeader eyebrow="B2B Lead Agent" title="B2B Leads" subtitle="Retailers discovered and qualified by your lead agent, ranked by fit." />
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
    </div>
  );
}
