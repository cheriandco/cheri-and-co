import { isLiveOrg } from "@/lib/auth/access";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getApprovals, getBrandRules, getContent, getContentSamples, getProducts, getSocialPosts } from "@/services";
import { SOCIAL_SAMPLE_NOTE } from "@/mocks/social-samples";
import { PostComposer } from "@/components/social";
import { CalendarGrid, MetricsTable, PlatformSummary, PostList, SocialStats } from "@/components/social-views";
import { ContentAgentPanel } from "@/components/content-agent-panel";
import { PageHeader, Tabs, DashboardCard, DataTable, SectionHeader, StatusBadge, Thumb, Money, EmptyState } from "@/components/ui";
import { ContentList } from "@/components/domain";
import { ApprovalQueue } from "@/components/interactive";

export const metadata: Metadata = { title: "Content & Marketing" };

const TABS = [
  ["overview", "Overview"], ["calendar", "Content Calendar"], ["create", "Create Post"], ["products", "Product Library"], ["brand", "Brand Brain"],
  ["assets", "Creative Assets"], ["approvals", "Approvals"], ["published", "Published"], ["performance", "Performance"],
].map(([id, label]) => ({ id, label }));

const WORKFLOW = ["Product Library", "Brand Brain", "Content Strategy", "Content Calendar", "Claude Creative Brain (planned)", "Creative Generation", "Canva Design (brief only)", "Human Approval", "Manual Publish (not automated)", "Performance"];

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ tab?: string; edit?: string }> }) {
  const live = await isLiveOrg();
  const { tab = "overview", edit } = await searchParams;
  const [content, rules, products, approvals, samples, social] = await Promise.all([getContent(), getBrandRules(), getProducts(), getApprovals(), getContentSamples(), getSocialPosts()]);
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const byDate = [...social].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const upcoming = byDate.filter((p) => p.scheduledFor >= todayIso && p.status !== "simulated_published").slice(0, 5);
  const simulated = byDate.filter((p) => p.status === "simulated_published").reverse();
  const editing = edit ? social.find((p) => p.id === edit && (p.status === "draft" || p.status === "rejected")) : undefined;

  return (
    <div className="stack">
      <PageHeader eyebrow="Content & Marketing Agent" title="Content & marketing" subtitle="From product to approval-ready content — no prompts to write. Your agent plans, drafts and waits for your approval." />
      <Tabs base="/content" tabs={TABS} active={tab} />
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {live
          ? "Posts, products and approvals here are your organisation's own records. This system does not publish anything: publish approved posts by hand."
          : "Calendar, product, brand, asset, approval and published items other than your own drafts are demonstration data from an earlier project, not verified Cheri & Co. information. This system does not publish anything."}
      </p>

      {tab === "overview" && (
        <div className="stack">
          <SocialStats posts={social} live={live} />
          {live ? <Unavailable title="Content pack generator" text="The pack generator works from the built-in sample catalogue, so it is not available for your organisation yet. Write posts in Create Post." /> : (
            <>
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{SOCIAL_SAMPLE_NOTE}</p>
              <ContentAgentPanel products={samples.products} packs={samples.packs} note={samples.note} />
            </>
          )}
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
            <DashboardCard><SectionHeader title="Coming up" href="/content?tab=calendar" /><PostList posts={upcoming} empty="Nothing planned" simulate={!live} /></DashboardCard>
            <DashboardCard><SectionHeader title="Needs your review" href="/approvals" /><ApprovalQueue initial={approvals.filter((a) => a.status === "pending" && a.type === "Content")} compact /></DashboardCard>
          </div>
        </div>
      )}

      {tab === "calendar" && (
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Social content calendar" extra={<span className="badge champagne plain">{live ? "Planning only" : "SAMPLE · planning only"}</span>} />
            <CalendarGrid posts={social} today={today} />
          </DashboardCard>
          <div className="grid even">
            <DashboardCard><SectionHeader title="Planned posts" /><PostList posts={byDate.filter((p) => p.status !== "simulated_published")} simulate={!live} /></DashboardCard>
            <div className="stack">
              <PlatformSummary posts={social} />
              {!live && <DashboardCard><SectionHeader title="Other planned content (sample)" /><ContentList items={content} /></DashboardCard>}
            </div>
          </div>
        </div>
      )}

      {tab === "create" && (
        <PostComposer key={editing?.id ?? "new"} postId={editing?.id} live={live} initial={editing && {
          title: editing.title, topic: editing.topic, platform: editing.platform, caption: editing.caption, hashtags: editing.hashtags.join(" "),
          creativeBrief: editing.creativeBrief, imageDirection: editing.imageDirection, scheduledFor: editing.scheduledFor,
        }} />
      )}

      {tab === "products" && (
        <DashboardCard flush>
          <DataTable rows={products} columns={[
            { header: "Product", primary: true, cell: (p) => <>{p.name}<small>{p.sku}</small></> },
            { header: "Category", cell: (p) => p.category },
            { header: "Price", cell: (p) => (p.price === null ? "—" : <Money value={p.price} />) },
            { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
          ]} empty={{ title: "No products yet", hint: "Add products on the Products page." }} />
        </DashboardCard>
      )}

      {tab === "brand" && live && <Unavailable title="Brand Brain" text="Brand rules are not stored in the database yet." />}
      {tab === "brand" && !live && (
        <div className="grid even">
          {rules.map((r) => <DashboardCard key={r.id} tint><div className="eyebrow">{r.title}</div><p className="serif" style={{ fontSize: 22 }}>{r.detail}</p></DashboardCard>)}
        </div>
      )}

      {tab === "assets" && live && <Unavailable title="Creative assets" text="Uploading and storing creative assets is not available yet. Use the creative brief and image direction on each post." />}
      {tab === "assets" && !live && (
        content.length ? (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {content.map((c) => (
              <DashboardCard key={c.id}><Thumb tone={c.tone} size="lg" /><div style={{ marginTop: 10, fontWeight: 500 }}>{c.name}</div><div className="muted" style={{ fontSize: 12 }}>{c.type} · {c.platform}</div></DashboardCard>
            ))}
          </div>
        ) : <EmptyState title="No creative assets yet" />
      )}

      {tab === "approvals" && <ApprovalQueue initial={approvals.filter((a) => a.type === "Content")} />}

      {tab === "published" && live && <Unavailable title="Published posts" text="This app never posts to a platform and does not track what was published by hand. Approved posts are ready for you to publish yourself." />}
      {tab === "published" && !live && (
        <DashboardCard>
          <SectionHeader title="Simulated publishing" extra={<span className="badge info plain">SIMULATED · not posted to any platform</span>} />
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>These posts were marked as published inside the demo only. Nothing was sent to Instagram, Facebook or LinkedIn. Approve a post, then choose “Simulate publish (demo)”.</p>
          <PostList posts={simulated} empty="No simulated posts yet" actions={false} />
        </DashboardCard>
      )}

      {tab === "performance" && live && <Unavailable title="Performance" text="No platform is connected, so reach and engagement are not measured." />}
      {tab === "performance" && !live && (
        <div className="stack">
          <DashboardCard>
            <SectionHeader title="Content performance" extra={<span className="badge champagne plain">SAMPLE metrics · not real performance</span>} />
            <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Invented numbers for demonstration. No platform is connected, so no real reach or engagement is measured.</p>
            <MetricsTable posts={social} />
          </DashboardCard>
        </div>
      )}
    </div>
  );
}

/** A section the database cannot back yet. Always says so, and never shows sample numbers. */
function Unavailable({ title, text }: { title: string; text: string }) {
  return (
    <DashboardCard>
      <SectionHeader title={title} extra={<span className="badge champagne plain">Not available yet</span>} />
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>{text}</p>
    </DashboardCard>
  );
}
