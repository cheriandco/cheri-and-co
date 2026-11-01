import { DashboardCard, PageHeader } from "./ui";

/** Shown to a live (non-demo) organisation on pages whose data has not been moved into the database yet.
 *  It never falls back to sample data: mixing sample and live records would mislead. */
export function NotConnected({ title }: { title: string }) {
  return (
    <div className="stack">
      <PageHeader eyebrow="Not connected yet" title={title} subtitle="This section is not connected to your database yet." />
      <DashboardCard>
        <p className="muted" style={{ fontSize: 13.5 }}>
          Your workspace is live, so the built-in sample data is hidden. Tasks and Approvals are connected now; this section is
          added in a later step. Nothing here has been lost.
        </p>
      </DashboardCard>
    </div>
  );
}
