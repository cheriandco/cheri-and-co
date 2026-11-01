/** Pure mapping between database rows and the app's types. No I/O, so it is tested without a database.
 *  The database uses UUIDs, timestamps and enums; the UI types carry display strings such as "Today". */
import type { Activity, AgentKey, Approval, AuditEntry, Priority, Task } from "@/types";

export interface TaskRow { id: string; title: string; source: string; due_at: string | null; priority: string; status: string; assignee_id: string | null; related_ref: string | null }
export interface ApprovalRow { id: string; title: string; type: string; generated_by: string; status: string; preview: string; meta: unknown; created_at: string }
export interface AuditRow { id: number; approval_id: string; action: string; actor_id: string; note: string | null; at: string }
export interface ActivityRow { id: number; agent: string | null; action: string; ref_id: string | null; actor_id: string | null; created_at: string }

const AGENTS: readonly string[] = ["b2c", "b2b", "amazon", "content", "crm"];
const isAgent = (v: string | null): v is AgentKey => v !== null && AGENTS.includes(v);

export function ago(iso: string, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function dueLabel(iso: string | null, now = new Date()): string {
  if (!iso) return "Unscheduled";
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return "Today";
  const tomorrow = new Date(now.getTime() + 86400000);
  if (dayKey(d) === dayKey(tomorrow)) return "Tomorrow";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** The UI lets people type "Today", "Tomorrow", "This week" or an ISO date; the database stores a timestamp.
 *  Anything else (including "Unscheduled") becomes no due date. */
export function parseDue(text: string | undefined | null, now = new Date()): string | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t || t === "unscheduled") return null;
  const at = (days: number) => { const d = new Date(now.getTime() + days * 86400000); d.setHours(17, 0, 0, 0); return d.toISOString(); };
  if (t === "today") return at(0);
  if (t === "tomorrow") return at(1);
  if (t === "this week") return at(7 - ((now.getDay() + 6) % 7) - 1 || 1);
  const parsed = new Date(text as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const asPriority = (v: string): Priority => (v === "high" || v === "low" ? v : "medium");

export function toTask(r: TaskRow, names: Map<string, string>, now = new Date()): Task {
  return {
    id: r.id, title: r.title, source: r.source, due: dueLabel(r.due_at, now), priority: asPriority(r.priority),
    assignee: (r.assignee_id && names.get(r.assignee_id)) || "Unassigned",
    status: r.status === "done" || r.status === "postponed" ? r.status : "open", href: r.related_ref || "/tasks",
  };
}

export function toApproval(r: ApprovalRow, now = new Date()): Approval {
  return {
    id: r.id, title: r.title, type: r.type as Approval["type"], generatedBy: (isAgent(r.generated_by) ? r.generated_by : "crm"),
    created: ago(r.created_at, now), status: r.status as Approval["status"], preview: r.preview, tone: "rose",
    meta: (r.meta ?? undefined) as Approval["meta"],
  };
}

export function toAudit(r: AuditRow, names: Map<string, string>): AuditEntry {
  return { id: String(r.id), approvalId: r.approval_id, action: r.action as AuditEntry["action"], actor: names.get(r.actor_id) ?? "A team member", at: r.at, note: r.note ?? undefined };
}

export function toActivity(r: ActivityRow, names: Map<string, string>, now = new Date()): Activity {
  const agent = isAgent(r.agent) ? r.agent : undefined;
  return { id: String(r.id), at: ago(r.created_at, now), actor: (r.actor_id && names.get(r.actor_id)) || (agent ? "Agent" : "A team member"), text: r.action, agent, ref: r.ref_id ?? undefined };
}
