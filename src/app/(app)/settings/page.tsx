import type { Metadata } from "next";
import { getAgents, getCurrentUser } from "@/services";
import { PageHeader, DashboardCard, SectionHeader, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Settings" };

const INTEGRATIONS = [
  ["Instagram", "Expires in 6 days", "champagne"], ["Supabase (CRM database)", "Not connected — mock data active", ""],
  ["Amazon Seller data", "Not connected", ""], ["Anthropic Claude (API)", "Not connected — drafts use templates. Needs an Anthropic Console API key; a Claude Team plan alone is not API access", ""],
  ["Canva", "Not connected — design briefs only", ""],
];

export default async function SettingsPage() {
  const [user, agents] = await Promise.all([getCurrentUser(), getAgents()]);
  return (
    <div className="stack">
      <PageHeader eyebrow="Workspace" title="Settings" subtitle="Profile, access and integrations." />
      <div className="grid even">
        <DashboardCard>
          <SectionHeader title="Profile" />
          <dl className="kv"><dt>Name</dt><dd>{user.name}</dd><dt>Email</dt><dd>{user.email}</dd><dt>Role</dt><dd>{user.role}</dd></dl>
          <p className="muted" style={{ marginTop: 16, fontSize: 12.5 }}>Sign-in and role-based access arrive with the authentication phase.</p>
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="Integrations" />
          <div className="list">{INTEGRATIONS.map(([n, s, t]) => <div className="list-item" key={n}><div className="body"><div className="title">{n}</div><div className="sub">{s}</div></div><span className={`badge ${t}`}>{t ? "Attention" : "Not connected"}</span></div>)}</div>
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="AI agents" />
          <p className="muted" style={{ marginBottom: 10 }}>Five agents report to the AI Business Orchestrator, a coordination layer.</p>
          <div className="list">{agents.map((a) => <div className="list-item" key={a.key}><div className="body"><div className="title">{a.name}</div></div><StatusBadge status={a.status} /></div>)}</div>
        </DashboardCard>
      </div>
    </div>
  );
}
