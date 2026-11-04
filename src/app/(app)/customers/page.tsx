import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getCustomers, getOrders, getRetailers } from "@/services";
import { PageHeader, DashboardCard, SectionHeader } from "@/components/ui";
import { CustomerTable } from "@/components/domain";
import { RecordForm } from "@/components/record-form";
import { ImportPanel } from "@/components/import-panel";
import { OrderTable } from "@/components/order-table";
import { IMPORT_COLUMNS, templateCsv } from "@/lib/import";
import { CUSTOMER_FIELDS, orderFields } from "@/lib/forms";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage() {
  const live = await isLiveOrg();
  const role = (await getAuthUser())?.role;
  const canWrite = live && can(role, "pipeline:write");
  const canOrder = live && can(role, "orders:write");
  const rows = await getCustomers();
  const [orders, retailers] = live ? await Promise.all([getOrders(), getRetailers()]) : [[], []];
  const who = new Map<string, string>([...rows.map((c): [string, string] => [c.id, c.name]), ...retailers.map((r): [string, string] => [r.id, r.business])]);
  const orderRows = orders.map((o) => ({
    id: o.id, date: o.orderedAt.slice(0, 10), channel: o.channel, status: o.status,
    who: (o.customerId && who.get(o.customerId)) || (o.retailerId && who.get(o.retailerId)) || "No customer or retailer",
    total: `₹${o.total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`,
  }));
  return (
    <div className="stack">
      <PageHeader eyebrow="CRM" title="Customers" subtitle="Everyone who has enquired or bought, with the full history behind them." />
      {canWrite && (
        <DashboardCard>
          <SectionHeader title="Add a customer" />
          <RecordForm id="new-customer" fields={CUSTOMER_FIELDS} endpoint="/api/customers" method="POST" submitLabel="Add customer" savedText="Customer added." resetOnSave
            invalidHint="Check the fields: a name is required, and email, phone and interests must be in a valid format." />
        </DashboardCard>
      )}
      <DashboardCard flush><CustomerTable rows={rows} /></DashboardCard>
      {canWrite && (
        <DashboardCard>
          <SectionHeader title="Import customers from CSV" />
          <ImportPanel resource="customers" noun="customers" template={templateCsv("customers")} columns={IMPORT_COLUMNS.customers} />
        </DashboardCard>
      )}
      {live && (
        <>
          <PageHeader eyebrow="Sales" title="Orders" subtitle="Record orders and move them through new, paid, shipped and delivered." />
          {canOrder && (
            <DashboardCard>
              <SectionHeader title="Record an order" />
              <RecordForm id="new-order" fields={orderFields(rows, retailers)} endpoint="/api/orders" method="POST" submitLabel="Record order" savedText="Order recorded." resetOnSave
                initial={{ channel: "instagram", status: "new" }}
                invalidHint="Check the fields: the total must be a number of 0 or more and the date must be YYYY-MM-DD." />
            </DashboardCard>
          )}
          <DashboardCard flush><div style={{ padding: 18 }}><OrderTable rows={orderRows} canWrite={canOrder} /></div></DashboardCard>
          {canOrder && (
            <DashboardCard>
              <SectionHeader title="Import orders from CSV" />
              <ImportPanel resource="orders" noun="orders" template={templateCsv("orders")} columns={IMPORT_COLUMNS.orders} />
            </DashboardCard>
          )}
        </>
      )}
    </div>
  );
}
