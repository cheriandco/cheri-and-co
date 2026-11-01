import { isLiveOrg } from "@/lib/auth/access";
import { NotConnected } from "@/components/not-connected";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActivities, getConversations, getCustomer, getTasks } from "@/services";
import { PageHeader, DashboardCard, SectionHeader, Avatar, StatusBadge, EmptyState } from "@/components/ui";
import { ActivityTimeline } from "@/components/domain";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  if (await isLiveOrg()) return <NotConnected title="Customer" />;
  const { id } = await params;
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
          <DashboardCard>
            <SectionHeader title="History" />
            <div className="grid three" style={{ marginBottom: 18 }}>
              <div><div className="muted">Amazon clicks</div><div className="serif" style={{ fontSize: 30 }}>{customer.amazonClicks}</div></div>
              <div><div className="muted">Flipkart clicks</div><div className="serif" style={{ fontSize: 30 }}>{customer.flipkartClicks}</div></div>
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
