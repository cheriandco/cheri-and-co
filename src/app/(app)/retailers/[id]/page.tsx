import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getActivities, getRetailer, getTasks } from "@/services";
import { PageHeader, DashboardCard, SectionHeader, Score, StatusBadge } from "@/components/ui";
import { ActivityTimeline } from "@/components/domain";
import { STAGE_LABELS } from "@/lib/agents";

export const metadata: Metadata = { title: "Retailer" };

export default async function RetailerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getRetailer(id);
  if (!r) notFound();
  const [tasks, activities] = await Promise.all([getTasks(), getActivities()]);
  const myTasks = tasks.filter((t) => t.href === `/retailers/${id}`);

  return (
    <div className="stack">
      <PageHeader eyebrow={r.category} title={r.business} subtitle={r.location} actions={<StatusBadge status={r.temperature} />} />
      <div className="grid two">
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Business" />
            <dl className="kv">
              <dt>Contact</dt><dd>{r.contact}</dd>
              <dt>Email</dt><dd>{r.email}</dd>
              <dt>Phone</dt><dd>{r.phone}</dd>
              <dt>Instagram</dt><dd>{r.instagram}</dd>
              <dt>Website</dt><dd>{r.website}</dd>
              <dt>Google Maps</dt><dd><a className="link" href={r.mapsUrl} target="_blank" rel="noopener noreferrer">Open map <ExternalLink size={12} /></a></dd>
            </dl>
          </DashboardCard>
          <DashboardCard>
            <SectionHeader title="Qualification" />
            <dl className="kv">
              <dt>Lead score</dt><dd><Score value={r.score} /></dd>
              <dt>Pipeline stage</dt><dd>{STAGE_LABELS[r.stage]} · <Link className="link" href="/crm?tab=pipeline">Open board</Link></dd>
              <dt>Notes</dt><dd>{r.qualification}</dd>
            </dl>
          </DashboardCard>
        </div>
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Tasks" href="/tasks" />
            {myTasks.length ? myTasks.map((t) => <div key={t.id} className="list-item"><div className="body"><div className="title">{t.title}</div><div className="sub">{t.due}</div></div><StatusBadge status={t.status} /></div>) : <p className="muted">No open tasks.</p>}
          </DashboardCard>
          <DashboardCard>
            <SectionHeader title="Activity timeline" />
            <ActivityTimeline items={activities} />
          </DashboardCard>
        </div>
      </div>
    </div>
  );
}
