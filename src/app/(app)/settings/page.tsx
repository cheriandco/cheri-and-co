import type { Metadata } from "next";
import { getAgents, getCurrentUser } from "@/services";
import { authRequired } from "@/lib/auth/mode";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { PageHeader, DashboardCard, SectionHeader, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Settings" };

/** Honest status: the database holds accounts and the schema only; every agent still reads sample data. */
function supabaseStatus(): string {
  if (authRequired()) return "Sign-in and organisation access active. Agent data is still SAMPLE data, not read from the database yet";
  if (isSupabaseConfigured()) return "Configured, but sign-in is off (demo mode). Agent data is SAMPLE data";
  return "Not connected — mock data active";
}

const integrations = (): string[][] => [
  ["Instagram", "Not connected (demo)", ""], ["Supabase (accounts and database)", supabaseStatus(), ""],
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
          <p className="muted" style={{ marginTop: 16, fontSize: 12.5 }}>{authRequired() ? "Signed-in account. Role and organisation come from the database." : "Sample profile for this demonstration. Set AUTH_MODE=required to turn on sign-in and role-based access."}</p>
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="Integrations" />
          <div className="list">{integrations().map(([n, s, t]) => <div className="list-item" key={n}><div className="body"><div className="title">{n}</div><div className="sub">{s}</div></div><span className={`badge ${t}`}>{t ? "Attention" : n.startsWith("Supabase") && authRequired() ? "Sign-in only" : "Not connected"}</span></div>)}</div>
        </DashboardCard>
        <DashboardCard>
          <SectionHeader title="AI agents" />
          <p className="muted" style={{ marginBottom: 10 }}>Five agents report to the AI Business Orchestrator, a coordination layer. Agent statuses shown here are simulated sample data; no live agent is running.</p>
          <div className="list">{agents.map((a) => <div className="list-item" key={a.key}><div className="body"><div className="title">{a.name}</div></div><StatusBadge status={a.status} /></div>)}</div>
        </DashboardCard>
      </div>
    </div>
  );
}
