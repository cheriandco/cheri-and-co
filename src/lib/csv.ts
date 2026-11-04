/** Small, dependency-free CSV reader (RFC 4180 style). Handles a byte-order mark, quoted cells, doubled quotes,
 *  commas and line breaks inside quotes, and CRLF, LF or CR row endings. Blank lines are kept as empty rows so line
 *  numbers still match the file; callers skip them. */
export class CsvError extends Error {}

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cellStarted) { quoted = true; cellStarted = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; cellStarted = false; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; cellStarted = false;
      continue;
    }
    cell += ch;
    cellStarted = true;
  }
  if (quoted) throw new CsvError("A quoted value is never closed. Check for a stray quotation mark.");
  if (cell !== "" || cellStarted || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** One CSV cell, quoted when it needs to be. */
const cellOut = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: string[][]): string => rows.map((r) => r.map(cellOut).join(",")).join("\r\n") + "\r\n";
