"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ImportReport, ImportRowReport } from "@/lib/import";

interface Outcome { report: ImportReport; created: number; failed: { line: number; label: string; error: string }[] }
const MAX_CHARS = 500_000;
const SHOWN = 100;

const badge = (s: ImportRowReport["status"]) => (s === "valid" ? "Ready" : s === "duplicate" ? "Duplicate" : "Problem");

/** CSV import: download the template, choose a file, preview (nothing is saved), then import. The server checks the file
 *  again at import time; this panel only shows what it reports. */
export function ImportPanel({ resource, noun, template, columns }: {
  resource: string; noun: string; template: string; columns: { name: string; required?: boolean; help: string }[];
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = noun.replace(/s$/, "");

  function download() {
    const url = URL.createObjectURL(new Blob([template], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${resource}-template.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function call(commit: boolean, text: string) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/import/${resource}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csv: text, commit }) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; report?: ImportReport; created?: number; failed?: Outcome["failed"] };
      if (!res.ok || !json.report) {
        setError(res.status === 403 ? "You do not have permission to import." : json.error ?? "The import could not be completed. Please try again.");
      } else if (commit) {
        setOutcome({ report: json.report, created: json.created ?? 0, failed: json.failed ?? [] });
        setReport(null); setCsv(null); setFileName("");
        if (input.current) input.current.value = "";
        router.refresh();
      } else setReport(json.report);
    } catch { setError("Could not reach the server. Please try again."); }
    setBusy(false);
  }

  async function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setReport(null); setOutcome(null); setError(null);
    if (!file) { setCsv(null); setFileName(""); return; }
    if (file.size > MAX_CHARS * 2) { setCsv(null); setError("This file is too large. Split it into smaller files."); return; }
    const text = await file.text();
    setCsv(text); setFileName(file.name);
    await call(false, text);
  }

  const rows = report?.rows ?? [];
  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Add many {noun} at once. Download the template, fill it in (delete the example row), then choose the file. You will see a preview first; nothing is saved until you confirm.
      </p>
      <details style={{ marginBottom: 12, fontSize: 13 }}>
        <summary>Columns</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {columns.map((c) => <li key={c.name}><code>{c.name}</code>{c.required ? " (required)" : ""}: {c.help}</li>)}
        </ul>
      </details>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <button type="button" className="btn" onClick={download}>Download template</button>
        <label className="btn" style={{ cursor: "pointer", position: "relative" }}>
          Choose CSV file
          <input ref={input} type="file" accept=".csv,text/csv" onChange={choose} style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }} aria-label={`Choose a CSV file of ${noun}`} />
        </label>
        {fileName && <span className="muted" style={{ alignSelf: "center", fontSize: 13 }}>{fileName}</span>}
      </div>

      <div aria-live="polite">
        {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>}

        {report && report.headerErrors.length > 0 && (
          <div role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
            <strong>This file cannot be imported:</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{report.headerErrors.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
        {report && report.warnings.map((w) => <p key={w} className="muted" style={{ fontSize: 13 }}>{w}</p>)}

        {report && report.headerErrors.length === 0 && (
          <>
            <p style={{ fontSize: 14, margin: "8px 0" }}>
              <strong>{report.counts.total}</strong> rows: <strong>{report.counts.valid}</strong> ready, <strong>{report.counts.duplicate}</strong> duplicate (will be skipped), <strong>{report.counts.invalid}</strong> with problems (will be skipped).
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead><tr>{["Line", one, "Result", "Details"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                <tbody>
                  {rows.slice(0, SHOWN).map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td><td className="primary">{r.label}</td>
                      <td style={{ color: r.status === "valid" ? "var(--sage)" : r.status === "invalid" ? "var(--danger)" : undefined }}>{badge(r.status)}</td>
                      <td className="muted">{r.status === "duplicate" ? r.note : r.errors.join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > SHOWN && <p className="muted" style={{ fontSize: 12 }}>Showing the first {SHOWN} of {rows.length} rows. All rows are checked.</p>}
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn primary" disabled={busy || report.counts.valid === 0 || !csv} onClick={() => csv && call(true, csv)}>
                {busy ? "Importing…" : `Import ${report.counts.valid} ${report.counts.valid === 1 ? one : noun}`}
              </button>
            </div>
          </>
        )}

        {outcome && (
          <div role="status" style={{ fontSize: 14 }}>
            <p style={{ margin: "8px 0" }}>
              <strong>Imported {outcome.created} of {outcome.report.counts.total} rows.</strong>{" "}
              {outcome.report.counts.duplicate} duplicate{outcome.report.counts.duplicate === 1 ? "" : "s"} skipped, {outcome.report.counts.invalid} with problems skipped
              {outcome.failed.length ? `, ${outcome.failed.length} could not be saved.` : "."}
            </p>
            {outcome.failed.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, color: "var(--danger)", fontSize: 13 }}>
                {outcome.failed.map((f) => <li key={f.line}>Line {f.line} ({f.label}): {f.error}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
