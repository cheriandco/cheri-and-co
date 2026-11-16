/** Orders sync. Window = (watermark or 30 days ago) .. (now - 5 min), by lastUpdatedTime so changed orders are picked up again; upserts make that safe.
 *  The watermark only advances when the whole window has been read, so an interrupted run re-reads, never skips. */
import { ThrottledError } from "../client";
import { searchOrdersPage } from "../api/orders";
import { ORDERS_END_LAG_MS, FIRST_LOOKBACK_DAYS, DEFAULT_PAGES_PER_STEP, asString, bump, waiting } from "./shared";
import type { ModuleOutcome, StepContext, SyncDeps } from "./types";

export async function ordersStep(deps: SyncDeps, ctx: StepContext): Promise<ModuleOutcome> {
  const { repo, client } = deps;
  const counts = { ...ctx.counts };
  let windowStart = asString(ctx.cursor.windowStart);
  let windowEnd = asString(ctx.cursor.windowEnd);
  let token = asString(ctx.cursor.nextToken);
  let window: ModuleOutcome["window"];
  if (!windowStart || !windowEnd) {
    const conn = await repo.getConnection();
    const now = deps.now();
    windowStart = conn?.ordersWatermark ?? new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86_400_000).toISOString();
    windowEnd = new Date(now.getTime() - ORDERS_END_LAG_MS).toISOString();
    window = { start: windowStart, end: windowEnd };
    token = null;
  }
  if (Date.parse(windowStart) >= Date.parse(windowEnd)) return { status: "done", cursor: {}, counts, window };

  const save = (): Record<string, unknown> => ({ windowStart, windowEnd, nextToken: token });
  const pages = deps.maxPagesPerStep ?? DEFAULT_PAGES_PER_STEP;
  for (let i = 0; i < pages; i++) {
    let page;
    try {
      page = await searchOrdersPage(client, { marketplaceId: repo.marketplaceId, lastUpdatedAfter: windowStart, lastUpdatedBefore: windowEnd, paginationToken: token });
    } catch (e) {
      if (e instanceof ThrottledError) return { ...waiting(e, save(), counts), window };
      throw e;
    }
    bump(counts, "orders", await repo.upsertOrders(page.orders, ctx.runId));
    bump(counts, "skipped", page.skipped);
    bump(counts, "pages", 1);
    token = page.nextToken;
    if (!token) {
      const end = windowEnd;
      return { status: "done", cursor: {}, counts, window, onDone: () => repo.upsertConnection({ ordersWatermark: end }) };
    }
  }
  return { status: "more", cursor: save(), counts, window };
}
