/** Reports API 2021-06-30. Reports are asynchronous: create, poll, then download from a presigned URL. Only allow-listed report types can be requested. */
import { gunzipSync } from "node:zlib";
import { downloadPresigned, type SpApiClient } from "../client";
import { iso, isRec, parseTsv, rec, str } from "../parse";
import type { AmazonReportInfo, ListingsReportSummary } from "../types";

/** The only report type this integration may create. Adding one is a deliberate code change, never a runtime input. */
export const ALLOWED_REPORT_TYPES = ["GET_MERCHANT_LISTINGS_DATA"] as const;
export type AllowedReportType = (typeof ALLOWED_REPORT_TYPES)[number];

export const MAX_REPORT_BYTES = 20 * 1024 * 1024;

export function mapReport(raw: unknown): AmazonReportInfo | null {
  const r = rec(raw);
  const id = str(r.reportId, 64);
  if (!id) return null;
  return {
    reportId: id, reportType: str(r.reportType, 80), status: str(r.processingStatus, 20) ?? "UNKNOWN", reportDocumentId: str(r.reportDocumentId, 128),
    dataStartTime: iso(r.dataStartTime), dataEndTime: iso(r.dataEndTime),
  };
}

export async function createReport(client: SpApiClient, marketplaceId: string, reportType: AllowedReportType): Promise<string> {
  if (!(ALLOWED_REPORT_TYPES as readonly string[]).includes(reportType)) throw new Error("This report type is not allowed.");
  const { data } = await client.request("createReport", { method: "POST", path: "/reports/2021-06-30/reports", body: { reportType, marketplaceIds: [marketplaceId] } });
  const id = isRec(data) ? str(data.reportId, 64) : null;
  if (!id) throw new Error("Amazon did not return a report id.");
  return id;
}

export async function getReport(client: SpApiClient, reportId: string): Promise<AmazonReportInfo | null> {
  const { data } = await client.request("getReport", { path: `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}` });
  return mapReport(data);
}

export async function getReportDocumentUrl(client: SpApiClient, documentId: string): Promise<{ url: string; gzip: boolean }> {
  const { data } = await client.request("getReportDocument", { path: `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}` });
  const body = rec(data);
  const url = str(body.url, 4000);
  if (!url) throw new Error("Amazon did not return a report document address.");
  return { url, gzip: str(body.compressionAlgorithm, 10) === "GZIP" };
}

/** Downloads and decodes one report document to text. The presigned URL stays inside this function. */
export async function fetchReportText(client: SpApiClient, documentId: string): Promise<string> {
  const { url, gzip } = await getReportDocumentUrl(client, documentId);
  const bytes = await downloadPresigned(client, url, MAX_REPORT_BYTES);
  const raw = gzip ? gunzipSync(bytes, { maxOutputLength: MAX_REPORT_BYTES }) : bytes;
  return new TextDecoder("utf-8").decode(raw);
}

const QTY_COLUMNS = ["quantity", "Quantity"];
const PRICE_COLUMNS = ["price", "Price"];

/** Aggregate counts only. The rows themselves are not stored, so nothing in the file beyond these counts reaches the database. */
export function summarizeListingsReport(text: string): ListingsReportSummary {
  const { columns, rows } = parseTsv(text);
  const qCol = QTY_COLUMNS.find((c) => columns.includes(c));
  const pCol = PRICE_COLUMNS.find((c) => columns.includes(c));
  let inStock = 0, outOfStock = 0, missingPrice = 0;
  for (const row of rows) {
    if (qCol) { const n = Number(row[qCol]); if (row[qCol] !== "" && Number.isFinite(n)) { if (n > 0) inStock++; else outOfStock++; } }
    if (pCol && (row[pCol] === "" || !(Number(row[pCol]) > 0))) missingPrice++;
  }
  // Header names come from Amazon's file; keep only a bounded, plain-text list so nothing unexpected is stored.
  return { rows: rows.length, columns: columns.slice(0, 100).map((c) => c.slice(0, 100)), inStock: qCol ? inStock : null, outOfStock: qCol ? outOfStock : null, missingPrice: pCol ? missingPrice : null };
}
