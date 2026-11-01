import { isLiveOrg } from "@/lib/auth/access";
import { NotConnected } from "@/components/not-connected";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getActionLinks, getActivities, getRetailer, getTasks } from "@/services";
import { followUpFor, qualificationFactors } from "@/lib/agent-logic";
import { QueueButton } from "@/components/agent-actions";
import { FactorList } from "@/components/agent-views";
import { PageHeader, DashboardCard, SectionHeader, Score, SimBadge, StatusBadge } from "@/components/ui";
import { ActivityTimeline } from "@/components/domain";
import { STAGE_LABELS } from "@/lib/agents";

export const metadata: Metadata = { title: "Retailer" };

export default async function RetailerPage({ params }: { params: Promise<{ id: string }> }) {
  if (await isLiveOrg()) return <NotConnected title="Retailer" />;
  const { id } = await params;
  const r = await getRetailer(id);
  if (!r) notFound();
  const [tasks, activities, links] = await Promise.all([getTasks(), getActivities(), getActionLinks()]);
  const follow = followUpFor(r);
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
          <DashboardCard>
            <SectionHeader title="Qualification factors" extra={<SimBadge>SAMPLE · rule-based</SimBadge>} />
            <FactorList factors={qualificationFactors(r)} />
          </DashboardCard>
          <DashboardCard tint>
            <SectionHeader title="Recommended follow-up" extra={<SimBadge />} />
            <p style={{ margin: "0 0 4px", fontWeight: 500 }}>{follow.title}</p>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>{follow.reason} Drafting sends nothing: the email waits in Approvals.</p>
            <QueueButton agent="b2b" refId={r.id} label="Draft follow-up email (demo)" link={links[`b2b:${r.id}`]} />
          </DashboardCard>
        </div>
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Tasks" href="/tasks" />
            {myTasks.length ? myTasks.map((t) => <div key={t.id} className="list-item"><div className="body"><div className="title">{t.title}</div><div className="sub">{t.due}</div></div><StatusBadge status={t.status} /></div>) : <p className="muted">No open tasks.</p>}
          </DashboardCard>
          <DashboardCard>
            <SectionHeader title="Activity timeline" />
            <ActivityTimeline items={activities.filter((a) => a.ref === id)} />
          </DashboardCard>
        </div>
      </div>
    </div>
  );
}
