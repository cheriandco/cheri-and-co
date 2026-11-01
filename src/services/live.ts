/** Live data, read and written through the signed-in user's own Supabase session, so Row Level Security applies to
 *  every call. The organisation always comes from the verified session (`orgId`), never from a request. Used only for
 *  organisations that are not flagged is_demo. This slice covers tasks, approvals, the audit log and agent activity. */
import { cache } from "react";
import { AuthError } from "@/lib/auth/access";
import { getAuthUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import type { Activity, AgentKey, Approval, AuditEntry, Task } from "@/types";
import {
  parseDue, toActivity, toApproval, toAudit, toTask,
  type ActivityRow, type ApprovalRow, type AuditRow, type TaskRow,
} from "./live-map";
import type { Store } from "./store";

export class LiveError extends Error {}

async function ctx() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();
  if (!user?.orgId || !supabase) throw new AuthError(401, "Authentication required");
  return { supabase, orgId: user.orgId, userId: user.id };
}

/** A database error becomes a 403 when Row Level Security or a missing privilege refused it, otherwise a plain error. */
function fail(error: { code?: string; message: string }): never {
  if (error.code === "42501" || /row-level security|permission denied|not authorized/i.test(error.message))
    throw new AuthError(403, "You do not have permission to do this");
  throw new LiveError("Database request failed");
}

async function names(supabase: Awaited<ReturnType<typeof ctx>>["supabase"], ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  const { data } = await supabase.from("profiles").select("id, display_name").in("id", unique);
  for (const p of (data ?? []) as { id: string; display_name: string | null }[]) if (p.display_name) out.set(p.id, p.display_name);
  return out;
}

export async function liveTasks(): Promise<Task[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("tasks").select("id, title, source, due_at, priority, status, assignee_id, related_ref")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(200);
  if (error) fail(error);
  const rows = (data ?? []) as TaskRow[];
  const n = await names(supabase, rows.map((r) => r.assignee_id));
  return rows.map((r) => toTask(r, n));
}

export async function liveCreateTask(input: Pick<Task, "title" | "due" | "priority">, from?: Pick<Task, "source" | "href">): Promise<Task> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("tasks").insert({
    org_id: orgId, title: input.title, priority: input.priority, due_at: parseDue(input.due),
    source: from?.source ?? "Manual", related_ref: from?.href ?? null,
  }).select("id, title, source, due_at, priority, status, assignee_id, related_ref").single();
  if (error) fail(error);
  await liveLog({ agent: "crm", action: `Created task: ${input.title}` });
  return toTask(data as TaskRow, new Map());
}

export async function liveUpdateTask(id: string, patch: Partial<Pick<Task, "status" | "due">>): Promise<Task | null> {
  const { supabase, orgId } = await ctx();
  const change: Record<string, unknown> = {};
  if (patch.status) change.status = patch.status;
  if (patch.due !== undefined) change.due_at = parseDue(patch.due);
  if (!Object.keys(change).length) return null;
  const { data, error } = await supabase.from("tasks").update(change).eq("org_id", orgId).eq("id", id)
    .select("id, title, source, due_at, priority, status, assignee_id, related_ref");
  if (error) fail(error);
  const row = ((data ?? []) as TaskRow[])[0];
  return row ? toTask(row, new Map()) : null;
}

export async function liveApprovals(): Promise<Approval[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("approvals").select("id, title, type, generated_by, status, preview, meta, created_at")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(200);
  if (error) fail(error);
  return ((data ?? []) as ApprovalRow[]).map((r) => toApproval(r));
}

export type LiveDecision =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "not_found" | "not_pending" | "prohibited_claims"; detail?: string[] };

/** The database function does the permission check, the state check and the audit row in one step, and records the
 *  real signed-in user as the actor. The claim guard still runs here before an approval. */
export async function liveDecideApproval(id: string, action: "approve" | "reject" | "edit", note?: string, edits?: { title?: string; preview?: string }): Promise<LiveDecision> {
  const { supabase, orgId } = await ctx();
  if (action === "approve") {
    const { data } = await supabase.from("approvals").select("preview, meta").eq("org_id", orgId).eq("id", id).maybeSingle();
    const row = data as { preview: string; meta: { kind?: string; allowedClaims?: string[] } | null } | null;
    if (row?.meta?.kind === "content_draft") {
      const violations = findProhibitedClaims(row.preview, row.meta.allowedClaims ?? []);
      if (violations.length) return { ok: false, reason: "prohibited_claims", detail: violations.map((v) => `${v.label}: "${v.match}"`) };
    }
  }
  const { data, error } = await supabase.rpc("decide_approval", { p_id: id, p_action: action, p_note: note ?? null, p_title: edits?.title ?? null, p_preview: edits?.preview ?? null });
  if (error) {
    if (/not found/i.test(error.message)) return { ok: false, reason: "not_found" };
    if (/already decided/i.test(error.message)) return { ok: false, reason: "not_pending" };
    fail(error);
  }
  const approval = toApproval(data as ApprovalRow);
  await liveLog({ agent: approval.generatedBy, action: `${action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Edited"}: ${approval.title}` });
  return { ok: true, approval };
}

export async function liveAudit(): Promise<AuditEntry[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("audit_log").select("id, approval_id, action, actor_id, note, at")
    .eq("org_id", orgId).order("at", { ascending: false }).limit(200);
  if (error) fail(error);
  const rows = ((data ?? []) as AuditRow[]).reverse(); // oldest first, like the sample store: the Approvals page reverses it
  const n = await names(supabase, rows.map((r) => r.actor_id));
  return rows.map((r) => toAudit(r, n));
}

export async function liveActivity(): Promise<Activity[]> {
  const { supabase, orgId } = await ctx();
  const { data, error } = await supabase.from("agent_activity").select("id, agent, action, ref_id, actor_id, created_at")
    .eq("org_id", orgId).order("created_at", { ascending: false }).limit(50);
  if (error) fail(error);
  const rows = (data ?? []) as ActivityRow[];
  const n = await names(supabase, rows.map((r) => r.actor_id));
  return rows.map((r) => toActivity(r, n));
}

/** Append-only history. A failure to log never undoes the action that was already saved. */
export async function liveLog(entry: { agent?: AgentKey; action: string }): Promise<void> {
  try {
    const { supabase, orgId, userId } = await ctx();
    await supabase.from("agent_activity").insert({ org_id: orgId, agent: entry.agent ?? null, action: entry.action.slice(0, 500), actor_id: userId });
  } catch { /* history is best effort */ }
}

/** The parts of the app's Store that live in the database. Everything else is empty on purpose: a live organisation
 *  never sees sample records. Memoised per request so one page render makes four queries at most. */
export const loadLiveStore = cache(async (): Promise<Store> => {
  const [tasks, approvals, audit, activity] = await Promise.all([liveTasks(), liveApprovals(), liveAudit(), liveActivity()]);
  return { tasks, approvals, audit, activity, deals: [], social: [], retailers: [], links: {} };
});
