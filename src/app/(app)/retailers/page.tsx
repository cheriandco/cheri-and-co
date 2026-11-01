import type { Metadata } from "next";
import { getRetailers } from "@/services";
import { PageHeader, DashboardCard } from "@/components/ui";
import { RetailerTable } from "@/components/domain";

export const metadata: Metadata = { title: "Retailers" };

export default async function RetailersPage() {
  const rows = await getRetailers();
  return (
    <div className="stack">
      <PageHeader eyebrow="CRM" title="Retailers" subtitle="Every boutique and gift store in your wholesale funnel." />
      <DashboardCard flush><RetailerTable rows={rows} /></DashboardCard>
    </div>
  );
}
