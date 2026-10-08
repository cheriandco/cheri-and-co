import type { Metadata } from "next";
import { getActivities, getConversations, getCustomers, getDeals, getRetailers, getTasks } from "@/services";
import { PageHeader, Tabs, DashboardCard } from "@/components/ui";
import { ActivityTimeline, ConversationList, CustomerTable, RetailerTable } from "@/components/domain";
import { PipelineBoard, TaskList } from "@/components/interactive";

export const metadata: Metadata = { title: "CRM & Sales Ops" };

const TABS = ["customers", "leads", "retailers", "conversations", "pipeline", "tasks", "activities"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));

export default async function CrmPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "customers" } = await searchParams;

  return (
    <div className="stack">
      <PageHeader eyebrow="CRM & Sales Operations Agent" title="CRM & sales ops" subtitle="One shared record for every customer, lead and retailer. All five agents read and write here." />
      <Tabs base="/crm" tabs={TABS} active={tab} />
      {tab === "customers" && <DashboardCard flush><CustomerTable rows={await getCustomers()} /></DashboardCard>}
      {(tab === "leads" || tab === "retailers") && <DashboardCard flush><RetailerTable rows={await getRetailers()} /></DashboardCard>}
      {tab === "conversations" && <DashboardCard><ConversationList items={await getConversations()} /></DashboardCard>}
      {tab === "pipeline" && <PipelineBoard initial={await getDeals()} />}
      {tab === "tasks" && <TaskList initial={await getTasks()} />}
      {tab === "activities" && <DashboardCard><ActivityTimeline items={await getActivities()} /></DashboardCard>}
    </div>
  );
}
