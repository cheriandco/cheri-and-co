/** FBA inventory snapshot. One call does the whole pass because Amazon's nextToken expires in about 30 seconds; if the page cap truncates it, the run fails
 *  loudly rather than storing a partial snapshot as if complete. A throttle simply asks to be retried (nothing is saved). */
import { ThrottledError } from "../client";
import { getInventory } from "../api/inventory";
import { bump, waiting } from "./shared";
import type { ModuleOutcome, StepContext, SyncDeps } from "./types";

export async function inventoryStep(deps: SyncDeps, ctx: StepContext): Promise<ModuleOutcome> {
  const counts = { ...ctx.counts };
  try {
    const res = await getInventory(deps.client, deps.repo.marketplaceId);
    if (res.truncated) throw new Error("The FBA inventory list is longer than one pass allows; nothing was saved.");
    bump(counts, "items", await deps.repo.upsertInventory(res.items, "fba"));
    bump(counts, "skipped", res.skipped);
    return { status: "done", cursor: {}, counts, onDone: () => deps.repo.upsertConnection({ inventorySyncedAt: deps.now().toISOString() }) };
  } catch (e) {
    if (e instanceof ThrottledError) return waiting(e, {}, counts);
    throw e;
  }
}
