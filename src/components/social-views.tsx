import Link from "next/link";
import { DashboardCard, DataTable, EmptyState, SectionHeader, Thumb } from "./ui";
import { SimulatePublish } from "./social";
import { STATUS_LABEL, buildCalendar, summarize } from "@/lib/social/posts";
import type { SocialPostView, SocialStatus } from "@/types/social";

const TONE: Record<SocialStatus, string> = { draft: "", pending_approval: "champagne", approved: "sage", rejected: "danger", simulated_published: "info" };
const PLATFORM_SHORT = { Instagram: "IG", Facebook: "FB", LinkedIn: "in" } as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const formatDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function SocialStatusBadge({ status }: { status: SocialStatus }) {
  return <span className={`badge ${TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function SocialStats({ posts, live = false }: { posts: SocialPostView[]; live?: boolean }) {
  const s = summarize(posts);
  const items: [string, number | string, string][] = [
    ["Planned posts", s.total, "Across Instagram, Facebook and LinkedIn"],
    ["Drafts", s.drafts, "Still being written"],
    ["Awaiting approval", s.pending, "Needs a human decision"],
    ["Approved", s.approved, live ? "Ready for you to publish by hand" : "Ready to simulate publishing"],
    ...(live ? [] : [["Simulated published", s.simulated, "Not posted anywhere"] as [string, number, string]]),
  ];
  return (
    <div className="grid kpis social-stats">
      {items.map(([label, value, note]) => (
        <div key={label} className="card kpi">
          <span className="label">{label}</span>
          <span className="value num">{value}</span>
          <span className="cmp">{note}</span>
        </div>
      ))}
    </div>
  );
}

export function CalendarGrid({ posts, today }: { posts: SocialPostView[]; today: Date }) {
  const weeks = buildCalendar(posts, today, 5);
  return (
    <div>
      <div className="cal-scroll">
        <div className="cal" role="table" aria-label="Social content calendar, recent and upcoming five weeks">
          <div className="cal-row cal-head" role="row">{WEEKDAYS.map((d) => <div key={d} role="columnheader">{d}</div>)}</div>
          {weeks.map((week) => (
            <div key={week[0].date} className="cal-row" role="row">
              {week.map((d) => (
                <div key={d.date} className={`cal-cell${d.isToday ? " today" : ""}${d.posts.length ? "" : " empty"}`} role="cell" aria-label={`${formatDay(d.date)}${d.posts.length ? `, ${d.posts.length} post${d.posts.length > 1 ? "s" : ""}` : ""}`}>
                  <span className="cal-day">{d.day === 1 || d.isToday ? `${d.day} ${d.month}` : d.day}</span>
                  {d.posts.map((p) => (
                    <span key={p.id} className="cal-chip" data-s={p.status} title={`${p.platform} · ${p.title} · ${STATUS_LABEL[p.status]}`}>
                      <b>{PLATFORM_SHORT[p.platform]}</b> {p.title}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="cal-legend" aria-label="Status key">
        {(Object.keys(STATUS_LABEL) as SocialStatus[]).map((s) => <span key={s} className="cal-chip" data-s={s}>{STATUS_LABEL[s]}</span>)}
        <span className="muted" style={{ fontSize: 12 }}>IG Instagram · FB Facebook · in LinkedIn. Dates are for planning only: nothing is posted.</span>
      </div>
    </div>
  );
}

export function PostList({ posts, empty, actions = true, simulate = true }: { posts: SocialPostView[]; empty?: string; actions?: boolean; simulate?: boolean }) {
  if (!posts.length) return <EmptyState title={empty ?? "No posts yet"} hint="Create a post to see it here." />;
  return (
    <div className="list">
      {posts.map((p) => (
        <div className="list-item" key={p.id}>
          <Thumb tone={p.tone} />
          <div className="body">
            <div className="title">{p.title}</div>
            <div className="sub">{p.platform} · {formatDay(p.scheduledFor)}{p.isSample ? " · SAMPLE" : simulate ? " · your draft" : ""}</div>
          </div>
          <div className="meta">
            <SocialStatusBadge status={p.status} />
            {actions && (p.status === "draft" || p.status === "rejected") && <Link className="btn sm" href={`/content?tab=create&edit=${p.id}`}>Edit</Link>}
            {actions && simulate && p.status === "approved" && <SimulatePublish id={p.id} />}
            {actions && p.status === "pending_approval" && <Link className="btn sm ghost" href="/content?tab=approvals">Review</Link>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MetricsTable({ posts }: { posts: SocialPostView[] }) {
  const rows = posts.filter((p) => p.metrics);
  return (
    <DataTable rows={rows} empty={{ title: "No simulated posts yet", hint: "Approve a post and choose “Simulate publish (demo)” to see sample metrics." }} columns={[
      { header: "Post", primary: true, cell: (p) => <>{p.title}<small>{p.platform} · {formatDay(p.scheduledFor)} · SAMPLE metrics</small></> },
      { header: "Reach", cell: (p) => <span className="num">{p.metrics?.reach.toLocaleString("en-IN")}</span> },
      { header: "Likes", cell: (p) => <span className="num">{p.metrics?.likes}</span> },
      { header: "Comments", cell: (p) => <span className="num">{p.metrics?.comments}</span> },
      { header: "Shares", cell: (p) => <span className="num">{p.metrics?.shares}</span> },
      { header: "Clicks", cell: (p) => <span className="num">{p.metrics?.clicks}</span> },
      { header: "Engagement", cell: (p) => <span className="num">{p.metrics?.engagement}%</span> },
    ]} />
  );
}

export function PlatformSummary({ posts }: { posts: SocialPostView[] }) {
  return (
    <DashboardCard>
      <SectionHeader title="By platform" />
      <div className="stack" style={{ gap: 10 }}>
        {(["Instagram", "Facebook", "LinkedIn"] as const).map((pl) => {
          const mine = posts.filter((p) => p.platform === pl);
          return (
            <div key={pl} className="row" style={{ justifyContent: "space-between", fontSize: 13.5 }}>
              <span>{pl}</span>
              <span className="muted">{mine.length} planned · {mine.filter((p) => p.status === "pending_approval").length} awaiting approval · {mine.filter((p) => p.status === "simulated_published").length} simulated</span>
            </div>
          );
        })}
      </div>
    </DashboardCard>
  );
}
