import type { Metadata } from "next";
import { getTasks } from "@/services";
import { PageHeader } from "@/components/ui";
import { TaskList } from "@/components/interactive";

export const metadata: Metadata = { title: "Tasks & Follow-ups" };

export default async function TasksPage() {
  const tasks = await getTasks();
  return (
    <div className="stack">
      <PageHeader eyebrow="CRM & Sales Operations Agent" title="Tasks & follow-ups" subtitle="Created by your agents and by you. Nothing slips through." />
      <TaskList initial={tasks} />
    </div>
  );
}
