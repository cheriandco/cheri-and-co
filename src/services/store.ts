/** Process-local mutable store standing in for the database while the UI runs
 *  on mock data. Replace with Supabase queries inside the services. */
import { approvals, deals, tasks } from "@/mocks/data";
import type { Approval, AuditEntry, Deal, Task } from "@/types";

interface Store {
  approvals: Approval[];
  tasks: Task[];
  deals: Deal[];
  audit: AuditEntry[];
}

const g = globalThis as unknown as { __imiStore?: Store };

export const store: Store = (g.__imiStore ??= {
  approvals: structuredClone(approvals),
  tasks: structuredClone(tasks),
  deals: structuredClone(deals),
  audit: [],
});
