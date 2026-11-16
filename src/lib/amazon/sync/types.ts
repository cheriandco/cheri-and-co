import type { SpApiClient } from "../client";
import type { AmazonRepo, SyncKind } from "../repo";

export interface SyncDeps {
  client: SpApiClient;
  repo: AmazonRepo;
  sellerId: string | null;
  now: () => Date;
  /** Pages (or API calls) one step may use before it saves its place and yields. Keeps each request short. */
  maxPagesPerStep?: number;
}

export type StepStatus = "done" | "more" | "waiting" | "failed";

export interface StepResult {
  kind: SyncKind;
  status: StepStatus;
  counts: Record<string, number>;
  /** When status is "waiting": a sensible delay before the next step. */
  retryAfterMs?: number;
  message?: string;
}

/** What a module sees of its run: it reads `cursor`, and returns the cursor to save. */
export interface StepContext { runId: string; cursor: Record<string, unknown>; counts: Record<string, number> }

export interface ModuleOutcome { status: StepStatus; cursor: Record<string, unknown>; counts: Record<string, number>; retryAfterMs?: number; window?: { start: string | null; end: string | null }; message?: string; onDone?: () => Promise<void> }
