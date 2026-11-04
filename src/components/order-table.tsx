"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ORDER_STATUSES } from "@/types";
import type { OrderStatus } from "@/types";

export interface OrderRowView { id: string; date: string; who: string; channel: string; total: string; status: OrderStatus }

/** The organisation's orders with a status control. Order details are fixed once recorded; the status is what moves. */
export function OrderTable({ rows, canWrite }: { rows: OrderRowView[]; canWrite: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/orders/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
      if (!res.ok) setError(res.status === 403 ? "You do not have permission to change orders." : "The status could not be changed. Please try again.");
      else router.refresh();
    } catch { setError("Could not reach the server. Please try again."); }
    setBusy(null);
  }

  if (!rows.length) return <p className="muted" style={{ margin: 0 }}>No orders yet. Record one above or import a CSV file.</p>;
  return (
    <div>
      <div className="table-wrap">
        <table className="data stack-sm">
          <thead><tr>{["Date", "Customer / retailer", "Channel", "Total", "Status"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Date">{r.date}</td>
                <td className="primary">{r.who}</td>
                <td data-label="Channel">{r.channel}</td>
                <td data-label="Total" className="num">{r.total}</td>
                <td data-label="Status">
                  {canWrite ? (
                    <select aria-label={`Status of the ${r.channel} order on ${r.date}`} value={r.status} disabled={busy === r.id} onChange={(e) => setStatus(r.id, e.target.value)}>
                      {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : r.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div aria-live="polite">{error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>}</div>
    </div>
  );
}
