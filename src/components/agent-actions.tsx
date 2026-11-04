"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardCard, Score, SectionHeader, StatusBadge } from "./ui";
import type { DiscoveryRow } from "@/services";
import type { Approval } from "@/types";

async function postJson(url: string, body: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: json.error ?? "Something went wrong. Please try again." };
  } catch {
    return { ok: false, error: "Could not reach the demo server. Please try again." };
  }
}

/** Runs one simulated action, then refreshes the page so server-rendered state (status chips, lists) updates. */
function useAction(run: () => Promise<{ ok: true } | { ok: false; error: string }>) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done" | { error: string }>("idle");
  const go = async () => {
    setState("busy");
    const res = await run();
    if (res.ok) { setState("done"); router.refresh(); } else setState({ error: res.error });
  };
  return { state, go };
}

const Problem = ({ state }: { state: unknown }) => (typeof state === "object" && state !== null && "error" in state
  ? <span role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{(state as { error: string }).error}</span> : null);

/** "Send to approval (demo)": queues an agent suggestion in Approvals. Shows the decision once it has one. */
export function QueueButton({ agent, refId, label = "Send to approval (demo)", link, live = false }: {
  agent: "b2c" | "b2b" | "amazon"; refId: string; label?: string; link?: { approvalId: string; status: Approval["status"] }; live?: boolean;
}) {
  const { state, go } = useAction(() => postJson("/api/agent-actions", { agent, ref: refId }));
  if (link?.status === "pending") return <span className="row" style={{ gap: 8 }}><span className="badge champagne">Pending approval</span><Link className="link" href="/approvals">Open</Link></span>;
  return (
    <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {link && <span className={`badge ${link.status === "rejected" ? "danger" : "sage"}`}>{link.status === "rejected" ? (live ? "Rejected" : "Rejected (demo)") : (live ? "Approved" : "Approved (demo)")}</span>}
      <button type="button" className="btn sm" disabled={state === "busy"} onClick={() => void go()}>
        {state === "busy" ? "Working…" : link ? "Queue again" : label}
      </button>
      <Problem state={state} />
    </span>
  );
}

export function SuggestionTaskButton({ sugKey }: { sugKey: string }) {
  const { state, go } = useAction(() => postJson("/api/crm/suggestions", { key: sugKey }));
  return (
    <span className="row" style={{ gap: 8 }}>
      <button type="button" className="btn sm" disabled={state === "busy" || state === "done"} onClick={() => void go()}>
        {state === "busy" ? "Working…" : state === "done" ? "Task created" : "Create task (demo)"}
      </button>
      <Problem state={state} />
    </span>
  );
}

function AddLead({ id }: { id: string }) {
  const { state, go } = useAction(() => postJson("/api/b2b/discover", { id }));
  return (
    <span className="row" style={{ gap: 8 }}>
      <button type="button" className="btn sm" disabled={state === "busy" || state === "done"} onClick={() => void go()}>
        {state === "busy" ? "Adding…" : state === "done" ? "Added" : "Add to leads (demo)"}
      </button>
      <Problem state={state} />
    </span>
  );
}

/** B2B retailer discovery over a fixed SAMPLE list. Nothing is searched, scraped or contacted. */
export function DiscoveryPanel({ note, candidates }: { note: string; candidates: DiscoveryRow[] }) {
  const [shown, setShown] = useState(false);
  return (
    <DashboardCard>
      <SectionHeader title="Retailer discovery" extra={<span className="badge champagne plain">Demo · SAMPLE candidates</span>} />
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>{note} Fit scores come from simple, visible rules, not from an AI model.</p>
      {!shown ? (
        <button type="button" className="btn primary" onClick={() => setShown(true)}>Run discovery (simulated)</button>
      ) : (
        <div className="list">
          {candidates.map((c) => (
            <div key={c.id} className="list-item" style={{ alignItems: "flex-start" }}>
              <div className="body">
                <div className="title">{c.business}</div>
                <div className="sub">{c.category} · {c.location}</div>
                <details style={{ marginTop: 6, fontSize: 12.5 }}>
                  <summary style={{ cursor: "pointer" }}>Why this score</summary>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {c.factors.map((f) => <li key={f.label}>{f.ok ? "✓" : "✗"} {f.label}: {f.note}</li>)}
                  </ul>
                </details>
              </div>
              <div className="meta">
                <Score value={c.score} />
                <StatusBadge status={c.temperature} />
                {c.added ? <span className="badge sage">In your leads</span> : <AddLead id={c.id} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardCard>
  );
}
