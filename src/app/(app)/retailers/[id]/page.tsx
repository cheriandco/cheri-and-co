import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getActionLinks, getActivities, getRetailer, getTasks } from "@/services";
import { followUpFor, qualificationFactors } from "@/lib/agent-logic";
import { QueueButton } from "@/components/agent-actions";
import { FactorList } from "@/components/agent-views";
import { PageHeader, DashboardCard, SectionHeader, Score, SimBadge, StatusBadge } from "@/components/ui";
import { ActivityTimeline } from "@/components/domain";
import { RecordForm } from "@/components/record-form";
import { RETAILER_FIELDS } from "@/lib/forms";
import { STAGE_LABELS } from "@/lib/agents";

export const metadata: Metadata = { title: "Retailer" };

/** A retailer field that was never filled in is shown as "Not recorded"; the edit form should start blank, not with that text. */
const unrecorded = (v: string) => (v === "Not recorded" ? "" : v);

export default async function RetailerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const live = await isLiveOrg();
  const canEdit = live && can((await getAuthUser())?.role, "pipeline:write");
  const canQueue = live && can((await getAuthUser())?.role, "agents:run");
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
          {canEdit && (
            <DashboardCard>
              <SectionHeader title="Edit retailer" />
              <RecordForm id={`edit-${r.id}`} fields={RETAILER_FIELDS} endpoint={`/api/retailers/${r.id}`} method="PATCH" submitLabel="Save changes" savedText="Retailer saved."
                initial={{
                  business: r.business, location: r.location, category: r.category, contact: unrecorded(r.contact), email: unrecorded(r.email), phone: unrecorded(r.phone),
                  instagram: unrecorded(r.instagram), website: unrecorded(r.website), qualification: r.qualification,
                }}
                invalidHint="Check the fields: a business name is required, and the other fields must not be too long." />
            </DashboardCard>
          )}
          <DashboardCard>
            <SectionHeader title="Qualification" />
            <dl className="kv">
              <dt>Lead score</dt><dd><Score value={r.score} /></dd>
              <dt>Pipeline stage</dt><dd>{STAGE_LABELS[r.stage]} · <Link className="link" href="/crm?tab=pipeline">Open board</Link></dd>
              <dt>Notes</dt><dd>{r.qualification}</dd>
            </dl>
          </DashboardCard>
          {!live && (
          <DashboardCard>
            <SectionHeader title="Qualification factors" extra={<SimBadge>SAMPLE · rule-based</SimBadge>} />
            <FactorList factors={qualificationFactors(r)} />
          </DashboardCard>
          )}
          {(!live || canQueue) && (
          <DashboardCard tint>
            <SectionHeader title="Recommended follow-up" extra={live ? undefined : <SimBadge />} />
            <p style={{ margin: "0 0 4px", fontWeight: 500 }}>{follow.title}</p>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>{follow.reason} Drafting sends nothing: a plain template email waits in Approvals for a person to review{live ? " and edit" : ""}.</p>
            <QueueButton agent="b2b" refId={r.id} label={live ? "Draft follow-up email" : "Draft follow-up email (demo)"} link={links[`b2b:${r.id}`]} live={live} />
          </DashboardCard>
          )}
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
