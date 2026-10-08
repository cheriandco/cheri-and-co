/** Minimal input validation for API routes (no extra dependency). */
import type { PipelineStage, Priority } from "@/types";

export const STAGES: PipelineStage[] = ["new", "qualified", "contacted", "interested", "negotiation", "won", "lost"];
export const PRIORITIES: Priority[] = ["high", "medium", "low"];

export const isStage = (v: unknown): v is PipelineStage => typeof v === "string" && (STAGES as string[]).includes(v);
export const isPriority = (v: unknown): v is Priority => typeof v === "string" && (PRIORITIES as string[]).includes(v);
export const str = (v: unknown, max = 500): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
