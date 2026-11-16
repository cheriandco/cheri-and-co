/** Runs ONE bounded step of one sync kind and keeps the run record honest. The client calls this repeatedly (see the sync route) until
 *  the status is "done" or "failed"; there is no background worker. Every run belongs to the repo's organisation and environment. */
import { describeApiProblem, SpApiError, ThrottledError } from "../client";
import { LwaError } from "../lwa";
import { safeMessage } from "../redact";
import { getMarketplaceParticipations, verifyMarketplace } from "../api/sellers";
import type { RunRow, SyncKind } from "../repo";
import { catalogStep } from "./catalog";
import { inventoryStep } from "./inventory";
import { ordersStep } from "./orders";
import { reportsStep } from "./reports";
import type { ModuleOutcome, StepContext, StepResult, SyncDeps } from "./types";

export const SYNC_KINDS: readonly SyncKind[] = ["orders", "catalog", "inventory", "reports"];

const MODULES: Record<SyncKind, (deps: SyncDeps, ctx: StepContext) => Promise<ModuleOutcome>> = {
  orders: ordersStep, catalog: catalogStep, inventory: inventoryStep, reports: reportsStep,
};

export interface VerifyResult { ok: boolean; message: string }

/** Asks Amazon which marketplaces the seller participates in and records whether the configured one is Amazon India and active. */
export async function verifyConnection(deps: SyncDeps): Promise<VerifyResult> {
  const { repo, client } = deps;
  const nowIso = deps.now().toISOString();
  try {
    const check = verifyMarketplace(await getMarketplaceParticipations(client), repo.marketplaceId);
    const p = check.participation;
    await repo.upsertConnection({
      marketplaceName: p?.name ?? null, countryCode: p?.countryCode ?? null, currencyCode: p?.currencyCode ?? null, storeName: p?.storeName ?? null,
      sellerId: deps.sellerId, participating: p?.participating ?? null, hasSuspendedListings: p?.hasSuspendedListings ?? null,
      status: check.ok ? "verified" : "failed", verifiedAt: check.ok ? nowIso : null,
      lastErrorCode: check.ok ? null : "marketplace_mismatch", lastErrorAt: check.ok ? null : nowIso,
    });
    return { ok: check.ok, message: check.ok ? "Connected to Amazon India." : check.reason };
  } catch (e) {
    const message = problemText(e);
    await repo.upsertConnection({ status: "failed", lastErrorCode: errorCode(e), lastErrorAt: nowIso });
    return { ok: false, message };
  }
}

export async function syncStep(deps: SyncDeps, kind: SyncKind): Promise<StepResult> {
  const { repo } = deps;
  const conn = await repo.getConnection();
  if (!conn || conn.status !== "verified") {
    return { kind, status: "failed", counts: {}, message: "Verify the Amazon connection before syncing." };
  }
  const run: RunRow = (await repo.activeRun(kind)) ?? (await repo.createRun(kind));
  await repo.updateRun(run.id, { status: "running" });
  const ctx: StepContext = { runId: run.id, cursor: run.cursor, counts: run.counts };
  const finish = deps.now().toISOString();
  try {
    const out = await MODULES[kind](deps, ctx);
    const patch = { cursor: out.cursor, counts: out.counts, windowStart: out.window?.start ?? run.windowStart, windowEnd: out.window?.end ?? run.windowEnd };
    if (out.status === "done") {
      await out.onDone?.();
      await repo.updateRun(run.id, { ...patch, status: "succeeded", finishedAt: finish, errorCode: null, errorMessage: null });
    } else {
      await repo.updateRun(run.id, { ...patch, status: out.status === "waiting" ? "waiting" : "running" });
    }
    return { kind, status: out.status, counts: out.counts, retryAfterMs: out.retryAfterMs, message: out.message };
  } catch (e) {
    if (e instanceof ThrottledError) {
      await repo.updateRun(run.id, { status: "waiting" });
      return { kind, status: "waiting", counts: run.counts, retryAfterMs: e.retryAfterMs, message: e.message };
    }
    const message = problemText(e);
    await repo.updateRun(run.id, { status: "failed", finishedAt: finish, errorCode: errorCode(e), errorMessage: message.slice(0, 500) });
    await repo.upsertConnection({ lastErrorCode: errorCode(e), lastErrorAt: finish });
    return { kind, status: "failed", counts: run.counts, message };
  }
}

function errorCode(e: unknown): string {
  if (e instanceof SpApiError) return (e.code ?? e.kind).slice(0, 100);
  if (e instanceof LwaError) return "lwa_error";
  return "sync_error";
}

function problemText(e: unknown): string {
  if (e instanceof SpApiError || e instanceof LwaError || e instanceof ThrottledError) return describeApiProblem(e);
  return safeMessage(e instanceof Error ? e.message : "Amazon sync failed.", []);
}
