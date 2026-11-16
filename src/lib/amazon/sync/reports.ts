/** Seller report (GET_MERCHANT_LISTINGS_DATA). Asynchronous: first step creates the report and saves its id; later steps poll it; when DONE the
 *  document is downloaded, reduced to aggregate counts and the file is discarded. A new run always makes a new report. */
import { ThrottledError } from "../client";
import { createReport, fetchReportText, getReport, summarizeListingsReport } from "../api/reports";
import { asString, waiting } from "./shared";
import type { ModuleOutcome, StepContext, SyncDeps } from "./types";

const POLL_MS = 15_000;
const REPORT_TYPE = "GET_MERCHANT_LISTINGS_DATA" as const;

export async function reportsStep(deps: SyncDeps, ctx: StepContext): Promise<ModuleOutcome> {
  const { client, repo } = deps;
  const counts = { ...ctx.counts };
  let reportId = asString(ctx.cursor.reportId);
  try {
    if (!reportId) {
      reportId = await createReport(client, repo.marketplaceId, REPORT_TYPE);
      return { status: "waiting", cursor: { reportId }, counts, retryAfterMs: POLL_MS, message: "Report requested; Amazon is preparing it." };
    }
    const info = await getReport(client, reportId);
    if (!info) throw new Error("Amazon returned an unreadable report status.");
    if (info.status === "IN_QUEUE" || info.status === "IN_PROGRESS") return { status: "waiting", cursor: { reportId }, counts, retryAfterMs: POLL_MS, message: "Amazon is still preparing the report." };
    if (info.status === "CANCELLED" || info.status === "FATAL") throw new Error(`Amazon ended the report with status ${info.status}.`);
    if (info.status !== "DONE" || !info.reportDocumentId) throw new Error("Amazon reported an unexpected report status.");
    const summary = summarizeListingsReport(await fetchReportText(client, info.reportDocumentId));
    await repo.upsertReport({ ...info, reportType: info.reportType ?? REPORT_TYPE }, summary, ctx.runId);
    counts.rows = summary.rows;
    return { status: "done", cursor: {}, counts, onDone: () => repo.upsertConnection({ reportsSyncedAt: deps.now().toISOString() }) };
  } catch (e) {
    if (e instanceof ThrottledError) return waiting(e, reportId ? { reportId } : {}, counts);
    throw e;
  }
}
