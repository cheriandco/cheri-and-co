import type { Metadata } from "next";
import { getCustomers } from "@/services";
import { PageHeader, DashboardCard } from "@/components/ui";
import { CustomerTable } from "@/components/domain";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage() {
  const rows = await getCustomers();
  return (
    <div className="stack">
      <PageHeader eyebrow="CRM" title="Customers" subtitle="Everyone who has enquired or bought, with the full history behind them." />
      <DashboardCard flush><CustomerTable rows={rows} /></DashboardCard>
    </div>
  );
}
