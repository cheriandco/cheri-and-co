import type { Metadata } from "next";
import { getApprovals, getAuditLog } from "@/services";
import { PageHeader, FilterBar, DashboardCard, SectionHeader, EmptyState } from "@/components/ui";
import { ApprovalQueue } from "@/components/interactive";
import { AGENT_NAMES } from "@/lib/agents";

export const metadata: Metadata = { title: "Approvals" };

const OPTIONS = [{ id: "any", label: "All" }, { id: "pending", label: "Pending" }, { id: "approved", label: "Approved" }, { id: "rejected", label: "Rejected" }];

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status = "pending" } = await searchParams;
  const [all, audit] = await Promise.all([getApprovals(), getAuditLog()]);
  const rows = status === "any" ? all : all.filter((a) => a.status === status);
  const titles = new Map(all.map((a) => [a.id, a.title]));

  return (
    <div className="stack">
      <PageHeader eyebrow="Human in the loop" title="Approval centre" subtitle="Everything your agents draft waits here until you say so. Every decision is logged." />
      <FilterBar base="/approvals" param="status" options={OPTIONS} active={status} />
      <div className="grid two">
        {/* key forces a fresh queue when the filter changes */}
        <ApprovalQueue key={status} initial={rows} />
        <DashboardCard>
          <SectionHeader title="Audit trail" />
          {audit.length === 0 ? <EmptyState title="No decisions yet" hint="Approvals, rejections and edits are recorded here." /> : (
            <ul className="timeline">
              {[...audit].reverse().map((e) => (
                <li key={e.id}><b style={{ fontWeight: 500 }}>{e.action}d</b> “{titles.get(e.approvalId)}”<small>{e.actor} · {new Date(e.at).toLocaleString("en-GB")}{e.note ? ` · ${e.note}` : ""}</small></li>
              ))}
            </ul>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 18 }}>Agents: {Object.values(AGENT_NAMES).join(" · ")}</p>
        </DashboardCard>
      </div>
    </div>
  );
}
