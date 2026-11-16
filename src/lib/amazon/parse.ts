/** Defensive readers for untyped Amazon JSON. Mappers use these to copy only named fields into typed objects, which is how nothing we did
 *  not ask for (buyer, recipient, anything Amazon adds later) can reach the database. */

export type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
export const rec = (v: unknown): Rec => (isRec(v) ? v : {});
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

/** Non-negative integer or null (quantities). */
export function qty(v: unknown): number | null {
  const n = int(v);
  return n !== null && n >= 0 ? n : null;
}

export function iso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Amazon money: `{ amount: "12.50", currencyCode: "INR" }`. */
export function money(v: unknown): { amount: number | null; currency: string | null } {
  const r = rec(v);
  const amount = num(r.amount);
  const currency = str(r.currencyCode, 3);
  return { amount: amount !== null && amount >= 0 ? amount : null, currency };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Splits a tab-separated flat file into header-named rows. Header-driven, so a column Amazon adds or moves cannot break the parser. */
export function parseTsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split("\t").map((c) => c.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    columns.forEach((c, i) => { row[c] = (cells[i] ?? "").trim(); });
    return row;
  });
  return { columns, rows };
}
