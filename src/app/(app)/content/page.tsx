import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getApprovals, getBrandRules, getContent, getContentSamples, getProducts } from "@/services";
import { ContentAgentPanel } from "@/components/content-agent-panel";
import { PageHeader, Tabs, DashboardCard, DataTable, SectionHeader, StatusBadge, Thumb, Money, EmptyState } from "@/components/ui";
import { ContentList } from "@/components/domain";
import { ApprovalQueue } from "@/components/interactive";

export const metadata: Metadata = { title: "Content & Marketing" };

const TABS = [
  ["overview", "Overview"], ["calendar", "Content Calendar"], ["products", "Product Library"], ["brand", "Brand Brain"],
  ["assets", "Creative Assets"], ["approvals", "Approvals"], ["published", "Published"], ["performance", "Performance"],
].map(([id, label]) => ({ id, label }));

const WORKFLOW = ["Product Library", "Brand Brain", "Content Strategy", "Content Calendar", "Claude Creative Brain (planned)", "Creative Generation", "Canva Design (brief only)", "Human Approval", "Manual Publish (not automated)", "Performance"];

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "overview" } = await searchParams;
  const [content, rules, products, approvals, samples] = await Promise.all([getContent(), getBrandRules(), getProducts(), getApprovals(), getContentSamples()]);
  const published = content.filter((c) => c.status === "published");

  return (
    <div className="stack">
      <PageHeader eyebrow="Content & Marketing Agent" title="Content & marketing" subtitle="From product to approval-ready content — no prompts to write. Your agent plans, drafts and waits for your approval." />
      <Tabs base="/content" tabs={TABS} active={tab} />
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Calendar, product, brand, asset, approval and published items other than your own drafts are demonstration data from an earlier project, not verified Cheri & Co. information. This system does not publish anything.</p>

      {tab === "overview" && (
        <div className="stack">
          <ContentAgentPanel products={samples.products} packs={samples.packs} note={samples.note} />
          <DashboardCard>
            <SectionHeader title="How content gets made" />
            <ol className="flow" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {WORKFLOW.map((w, i) => (
                <li key={w} className="row" style={{ gap: 8 }}>
                  <span className={w === "Human Approval" ? "on" : ""}>{w}</span>
                  {i < WORKFLOW.length - 1 && <ChevronRight size={14} />}
                </li>
              ))}
            </ol>
          </DashboardCard>
          <div className="grid even">
            <DashboardCard><SectionHeader title="Coming up" href="/content?tab=calendar" /><ContentList items={content.filter((c) => c.status !== "published").slice(0, 4)} /></DashboardCard>
            <DashboardCard><SectionHeader title="Needs your review" href="/approvals" /><ApprovalQueue initial={approvals.filter((a) => a.status === "pending" && a.type === "Content")} compact /></DashboardCard>
          </div>
        </div>
      )}

      {tab === "calendar" && <DashboardCard><ContentList items={content} /></DashboardCard>}

      {tab === "products" && (
        <DashboardCard flush>
          <DataTable rows={products} columns={[
            { header: "Product", primary: true, cell: (p) => <>{p.name}<small>{p.sku}</small></> },
            { header: "Category", cell: (p) => p.category },
            { header: "Price", cell: (p) => <Money value={p.price} /> },
            { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
          ]} />
        </DashboardCard>
      )}

      {tab === "brand" && (
        <div className="grid even">
          {rules.map((r) => <DashboardCard key={r.id} tint><div className="eyebrow">{r.title}</div><p className="serif" style={{ fontSize: 22 }}>{r.detail}</p></DashboardCard>)}
        </div>
      )}

      {tab === "assets" && (
        content.length ? (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {content.map((c) => (
              <DashboardCard key={c.id}><Thumb tone={c.tone} size="lg" /><div style={{ marginTop: 10, fontWeight: 500 }}>{c.name}</div><div className="muted" style={{ fontSize: 12 }}>{c.type} · {c.platform}</div></DashboardCard>
            ))}
          </div>
        ) : <EmptyState title="No creative assets yet" />
      )}

      {tab === "approvals" && <ApprovalQueue initial={approvals.filter((a) => a.type === "Content")} />}

      {tab === "published" && <DashboardCard><ContentList items={published} /></DashboardCard>}

      {tab === "performance" && (
        <DashboardCard flush>
          <DataTable rows={published} columns={[
            { header: "Content", primary: true, cell: (c) => <>{c.name}<small>{c.platform} · {c.type}</small></> },
            { header: "Published", cell: (c) => c.date },
            { header: "Reach", cell: (c) => <span className="num">{c.reach?.toLocaleString("en-IN")}</span> },
            { header: "Engagement", cell: (c) => <span className="num">{c.engagement}%</span> },
          ]} />
        </DashboardCard>
      )}
    </div>
  );
}
