import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getActivities, getConversations, getCustomer, getTasks } from "@/services";
import { PageHeader, DashboardCard, SectionHeader, Avatar, StatusBadge, EmptyState } from "@/components/ui";
import { ActivityTimeline } from "@/components/domain";
import { RecordForm } from "@/components/record-form";
import { CUSTOMER_FIELDS } from "@/lib/forms";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const live = await isLiveOrg();
  const canEdit = live && can((await getAuthUser())?.role, "pipeline:write");
  const customer = await getCustomer(id);
  if (!customer) notFound();
  const [convos, tasks, activities] = await Promise.all([getConversations(), getTasks(), getActivities()]);
  const mine = convos.filter((c) => c.customerId === id);
  const myTasks = tasks.filter((t) => t.href === `/customers/${id}`);

  return (
    <div className="stack">
      <PageHeader eyebrow="Customer" title={customer.name} subtitle={`${customer.city} · customer since ${customer.firstSeen}`} actions={<Avatar name={customer.name} size="lg" />} />
      <div className="grid two">
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Contact" />
            <dl className="kv">
              <dt>Instagram</dt><dd>{customer.instagram}</dd>
              <dt>Phone</dt><dd>{customer.phone}</dd>
              <dt>Email</dt><dd>{customer.email}</dd>
              <dt>Interests</dt><dd>{customer.interests.map((i) => <span className="tag" key={i}>{i}</span>)}</dd>
            </dl>
          </DashboardCard>
          {canEdit && (
            <DashboardCard>
              <SectionHeader title="Edit customer" />
              <RecordForm id={`edit-${customer.id}`} fields={CUSTOMER_FIELDS} endpoint={`/api/customers/${customer.id}`} method="PATCH" submitLabel="Save changes" savedText="Customer saved."
                initial={{ name: customer.name, email: customer.email, phone: customer.phone, instagram: customer.instagram, city: customer.city, interests: customer.interests.join(", ") }}
                invalidHint="Check the fields: a name is required, and email, phone and interests must be in a valid format." />
            </DashboardCard>
          )}
          <DashboardCard>
            <SectionHeader title="History" />
            <div className="grid three" style={{ marginBottom: 18 }}>
              {/* click counts have no database column, so a live organisation sees purchases only */}
              {!live && <div><div className="muted">Amazon clicks</div><div className="serif" style={{ fontSize: 30 }}>{customer.amazonClicks}</div></div>}
              {!live && <div><div className="muted">Flipkart clicks</div><div className="serif" style={{ fontSize: 30 }}>{customer.flipkartClicks}</div></div>}
              <div><div className="muted">Purchases</div><div className="serif" style={{ fontSize: 30 }}>{customer.purchases}</div></div>
            </div>
            <h3 className="eyebrow">Conversations</h3>
            {mine.length ? mine.map((c) => (
              <div key={c.id} className="list-item"><div className="body"><div className="title">{c.product}</div><div className="sub">“{c.message}”</div></div><StatusBadge status={c.status} /></div>
            )) : <EmptyState title="No conversations yet" />}
          </DashboardCard>
        </div>
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Tasks" href="/tasks" />
            {myTasks.length ? myTasks.map((t) => <div key={t.id} className="list-item"><div className="body"><div className="title">{t.title}</div><div className="sub">{t.due}</div></div><StatusBadge status={t.status} /></div>) : <p className="muted">No open tasks. <Link className="link" href="/tasks">View all</Link></p>}
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
