"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface FieldSpec {
  name: string; label: string; kind?: "text" | "select" | "textarea"; options?: [string, string][];
  placeholder?: string; required?: boolean; maxLength?: number; /** a number of 0 or more */ numeric?: boolean;
  /** Typed as comma- or semicolon-separated text, sent as a list. */ list?: boolean;
  /** A date as YYYY-MM-DD; `words` are also accepted (for example Today). Blank is allowed unless the field is required. */ date?: { words?: string[] };
}

interface Props {
  /** Makes element ids unique when several forms are on one page. */
  id: string;
  fields: FieldSpec[];
  initial?: Record<string, string>;
  endpoint: string;
  method: "POST" | "PATCH";
  submitLabel: string;
  savedText: string;
  /** Clear the form after a successful create. */
  resetOnSave?: boolean;
  /** Shown for a 400 answer from the server. */
  invalidHint: string;
}

/** One small form used for every M2 record (customer, retailer, task, order). The server re-validates everything and takes the
 *  organisation from the signed-in session, so nothing here decides who may save what. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The first problem with the typed values, or null. Mirrors what the server will accept so a typo is caught before saving
 *  (a date such as 04/11/2026 would otherwise be read in an unexpected order). The server still re-validates everything. */
export function fieldProblem(fields: FieldSpec[], v: Record<string, string>): string | null {
  for (const f of fields) {
    const value = (v[f.name] ?? "").trim();
    if (f.required && !value) return `${f.label} is required.`;
    if (f.numeric && value && !(Number.isFinite(Number(value)) && Number(value) >= 0)) return `${f.label} must be a number, 0 or more.`;
    if (f.date && value) {
      const valid = ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
      if (!valid && !(f.date.words ?? []).includes(value.toLowerCase())) return `${f.label} must be a date as YYYY-MM-DD${f.date.words?.length ? `, or ${f.date.words.join(", ")}` : ""}.`;
    }
  }
  return null;
}

export function RecordForm({ id, fields, initial, endpoint, method, submitLabel, savedText, resetOnSave, invalidHint }: Props) {
  const router = useRouter();
  const blank = Object.fromEntries(fields.map((f) => [f.name, f.kind === "select" ? f.options?.[0]?.[0] ?? "" : ""]));
  const [v, setV] = useState<Record<string, string>>({ ...blank, ...initial });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const set = (k: string, val: string) => { setV((x) => ({ ...x, [k]: val })); setNotice(null); };

  function bodyOf(): Record<string, unknown> {
    return Object.fromEntries(fields.map((f) => {
      const value = (v[f.name] ?? "").trim();
      return [f.name, f.list ? value.split(/[;,]/).map((x) => x.trim()).filter(Boolean) : value];
    }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const bad = fieldProblem(fields, v);
    if (bad) { setNotice({ kind: "error", text: bad }); return; }
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(endpoint, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOf()) });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setNotice({ kind: "ok", text: savedText });
        if (resetOnSave) setV({ ...blank });
        router.refresh();
      } else {
        setNotice({ kind: "error", text: res.status === 400 ? invalidHint : res.status === 403 ? "You do not have permission to do this." : json.error ?? "Something went wrong. Please try again." });
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Please try again." });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={save} noValidate>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0 16px" }}>
        {fields.map((f) => {
          const fid = `${id}-${f.name}`;
          return (
            <div className="field" key={f.name}>
              <label htmlFor={fid}>{f.label}{f.required ? " *" : ""}</label>
              {f.kind === "select" ? (
                <select id={fid} value={v[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)}>
                  {(f.options ?? []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea id={fid} value={v[f.name] ?? ""} maxLength={f.maxLength} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input id={fid} value={v[f.name] ?? ""} maxLength={f.maxLength} placeholder={f.placeholder} inputMode={f.numeric ? "decimal" : undefined} onChange={(e) => set(f.name, e.target.value)} />
              )}
            </div>
          );
        })}
      </div>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
      <div aria-live="polite" style={{ marginTop: 12 }}>
        {notice && <p role={notice.kind === "error" ? "alert" : "status"} style={{ margin: 0, fontSize: 13, color: notice.kind === "error" ? "var(--danger)" : "var(--sage)" }}>{notice.text}</p>}
      </div>
    </form>
  );
}
