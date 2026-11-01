/** Roles and permissions. Pure data, no I/O, safe to import anywhere.
 *  ASSUMPTION: this role set and matrix are a proposal pending client confirmation (docs/API.md §5). */

export const ROLES = ["owner", "admin", "approver", "staff", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "data:read",
  "tasks:write",
  "pipeline:write",
  "products:write",
  "agents:run",
  "content:submit",
  "approvals:decide",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const WRITERS: Role[] = ["owner", "admin", "approver", "staff"];

const MATRIX: Record<Permission, readonly Role[]> = {
  "data:read": ROLES,
  "tasks:write": WRITERS,
  "pipeline:write": WRITERS,
  "products:write": WRITERS,
  "agents:run": WRITERS,
  "content:submit": WRITERS,
  "approvals:decide": ["owner", "admin", "approver"],
};

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export const can = (role: Role | null | undefined, permission: Permission): boolean =>
  role != null && MATRIX[permission].includes(role);

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner", admin: "Admin", approver: "Approver", staff: "Staff", viewer: "Viewer (read-only)",
};
