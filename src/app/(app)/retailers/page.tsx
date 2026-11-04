import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getRetailers } from "@/services";
import { PageHeader, DashboardCard, SectionHeader } from "@/components/ui";
import { RetailerTable } from "@/components/domain";
import { RecordForm } from "@/components/record-form";
import { ImportPanel } from "@/components/import-panel";
import { IMPORT_COLUMNS, templateCsv } from "@/lib/import";
import { RETAILER_FIELDS } from "@/lib/forms";

export const metadata: Metadata = { title: "Retailers" };

export default async function RetailersPage() {
  const canWrite = (await isLiveOrg()) && can((await getAuthUser())?.role, "pipeline:write");
  const rows = await getRetailers();
  return (
    <div className="stack">
      <PageHeader eyebrow="CRM" title="Retailers" subtitle="Every boutique and gift store in your wholesale funnel." />
      {canWrite && (
        <DashboardCard>
          <SectionHeader title="Add a retailer" />
          <RecordForm id="new-retailer" fields={RETAILER_FIELDS} endpoint="/api/retailers" method="POST" submitLabel="Add retailer" savedText="Retailer added to the pipeline." resetOnSave
            invalidHint="Check the fields: a business name is required, and the other fields must not be too long." />
        </DashboardCard>
      )}
      <DashboardCard flush><RetailerTable rows={rows} /></DashboardCard>
      {canWrite && (
        <DashboardCard>
          <SectionHeader title="Import retailers from CSV" />
          <ImportPanel resource="retailers" noun="retailers" template={templateCsv("retailers")} columns={IMPORT_COLUMNS.retailers} />
        </DashboardCard>
      )}
    </div>
  );
}
