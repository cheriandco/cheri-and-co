"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const KINDS = ["orders", "catalog", "inventory", "reports"] as const;
const LABEL: Record<(typeof KINDS)[number], string> = { orders: "Orders", catalog: "Listings & catalog", inventory: "FBA inventory", reports: "Seller report" };
/** A step that says "come back later" for longer than this is left for the next click: the run keeps its place on the server. */
const MAX_INLINE_WAIT_MS = 20_000;
const MAX_STEPS = 60;

interface StepAnswer { status: "done" | "more" | "waiting" | "failed"; retryAfterMs?: number; message?: string; counts?: Record<string, number> }

async function call<T>(url: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
    return res.ok && json.data !== undefined ? { ok: true, data: json.data } : { ok: false, error: json.error ?? "Something went wrong. Please try again." };
  } catch { return { ok: false, error: "Could not reach the server. Please try again." }; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Owner/admin controls. The server runs one bounded step per request; this loop repeats them, so no background job is needed. */
export function AmazonSyncControls({ canSync, verified }: { canSync: boolean; verified: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  if (!canSync) return <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Only an owner or admin can connect or sync Amazon. You can view everything here.</p>;
  const add = (line: string) => setLog((l) => [...l.slice(-8), line]);

  async function verify() {
    setBusy(true); setLog([]);
    const r = await call<{ ok: boolean; message: string }>("/api/amazon/connection");
    add(r.ok ? r.data.message : r.error);
    setBusy(false); router.refresh();
  }

  async function syncAll() {
    setBusy(true); setLog([]);
    for (const kind of KINDS) {
      let steps = 0;
      for (;;) {
        if (++steps > MAX_STEPS) { add(`${LABEL[kind]}: paused (step limit). Click Sync again to continue.`); break; }
        const r = await call<StepAnswer>("/api/amazon/sync", { kind });
        if (!r.ok) { add(`${LABEL[kind]}: ${r.error}`); setBusy(false); router.refresh(); return; }
        const s = r.data;
        if (s.status === "done") { add(`${LABEL[kind]}: done${s.counts ? ` (${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}`); break; }
        if (s.status === "failed") { add(`${LABEL[kind]}: failed. ${s.message ?? ""}`); break; }
        if (s.status === "waiting") {
          if ((s.retryAfterMs ?? 0) > MAX_INLINE_WAIT_MS) { add(`${LABEL[kind]}: Amazon's rate limit applies. Progress is saved; click Sync again in about ${Math.ceil((s.retryAfterMs ?? 0) / 60000)} minute(s).`); break; }
          await sleep(s.retryAfterMs ?? 5000);
        }
      }
    }
    setBusy(false); router.refresh();
  }

  async function generate() {
    setBusy(true); setLog([]);
    const r = await call<{ created: number; total: number }>("/api/amazon/insights/generate");
    add(r.ok ? `Insights updated: ${r.data.created} new, ${r.data.total} current.` : r.error);
    setBusy(false); router.refresh();
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void verify()}>{verified ? "Re-verify connection" : "Verify connection"}</button>
        <button type="button" className="btn sm" disabled={busy || !verified} onClick={() => void syncAll()}>{busy ? "Working…" : "Sync now"}</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void generate()}>Refresh insights</button>
      </div>
      {log.length > 0 && <ul className="muted" style={{ fontSize: 12.5, margin: 0, paddingLeft: 18 }} aria-live="polite">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  );
}

/** Sends one insight to the existing Approvals queue. Approving it later records a decision only; nothing is changed on Amazon. */
export function AmazonInsightSend({ id, status, simulated, canQueue }: { id: string; status: "draft" | "submitted" | "dismissed"; simulated: boolean; canQueue: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | { error: string }>("idle");
  if (status === "submitted") return <span className="badge champagne">In Approvals</span>;
  if (simulated) return <span className="muted" style={{ fontSize: 12 }}>Simulated data: cannot be sent for approval</span>;
  if (!canQueue) return null;
  return (
    <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="btn sm" disabled={state === "busy"} onClick={async () => {
        setState("busy");
        const r = await call<unknown>(`/api/amazon/insights/${encodeURIComponent(id)}/queue`);
        if (r.ok) { setState("idle"); router.refresh(); } else setState({ error: r.error });
      }}>{state === "busy" ? "Sending…" : "Send to approval"}</button>
      {typeof state === "object" && <span role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{state.error}</span>}
    </span>
  );
}
