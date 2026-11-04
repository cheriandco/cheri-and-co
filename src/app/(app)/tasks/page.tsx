import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getTasks } from "@/services";
import { PageHeader, DashboardCard, SectionHeader } from "@/components/ui";
import { TaskList } from "@/components/interactive";
import { RecordForm } from "@/components/record-form";
import { ImportPanel } from "@/components/import-panel";
import { IMPORT_COLUMNS, templateCsv } from "@/lib/import";
import { TASK_FIELDS } from "@/lib/forms";

export const metadata: Metadata = { title: "Tasks & Follow-ups" };

export default async function TasksPage() {
  const live = await isLiveOrg();
  const canWrite = live && can((await getAuthUser())?.role, "tasks:write");
  const tasks = await getTasks();
  return (
    <div className="stack">
      <PageHeader eyebrow="CRM & Sales Operations Agent" title="Tasks & follow-ups" subtitle="Created by your agents and by you. Nothing slips through." />
      {canWrite && (
        <DashboardCard>
          <SectionHeader title="Add a task" />
          <RecordForm id="new-task" fields={TASK_FIELDS} endpoint="/api/tasks" method="POST" submitLabel="Add task" savedText="Task added." resetOnSave
            invalidHint="Check the fields: a task title is required." />
        </DashboardCard>
      )}
      <TaskList key={tasks.map((t) => `${t.id}:${t.status}:${t.due}`).join("|")} initial={tasks} live={live} />
      {canWrite && (
        <DashboardCard>
          <SectionHeader title="Import tasks from CSV" />
          <ImportPanel resource="tasks" noun="tasks" template={templateCsv("tasks")} columns={IMPORT_COLUMNS.tasks} />
        </DashboardCard>
      )}
    </div>
  );
}
