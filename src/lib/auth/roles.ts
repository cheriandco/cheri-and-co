/** Roles and permissions. Pure data, no I/O, safe to import anywhere.
 *  ASSUMPTION: this role set and matrix are a proposal pending client confirmation (docs/API.md §5). */

export const ROLES = ["owner", "admin", "approver", "staff", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "data:read",
  "tasks:write",
  "pipeline:write",
  "products:write",
  /** Deleting a product. Owner and admin only, matching the database's delete policy (is_admin). */
  "products:delete",
  "orders:write",
  "agents:run",
  "content:submit",
  /** B2C enquiries, drafted replies and their follow-ups. Same writers as the database policies (can_write). */
  "enquiries:write",
  "approvals:decide",
  /** Amazon Intelligence: connect and run synchronisation. Owner and admin only (it spends Amazon API quota). */
  "amazon:sync",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const WRITERS: Role[] = ["owner", "admin", "approver", "staff"];

const MATRIX: Record<Permission, readonly Role[]> = {
  "data:read": ROLES,
  "tasks:write": WRITERS,
  "pipeline:write": WRITERS,
  "products:write": WRITERS,
  "products:delete": ["owner", "admin"],
  "orders:write": WRITERS,
  "agents:run": WRITERS,
  "content:submit": WRITERS,
  "enquiries:write": WRITERS,
  "approvals:decide": ["owner", "admin", "approver"],
  "amazon:sync": ["owner", "admin"],
};

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export const can = (role: Role | null | undefined, permission: Permission): boolean =>
  role != null && MATRIX[permission].includes(role);

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner", admin: "Admin", approver: "Approver", staff: "Staff", viewer: "Viewer (read-only)",
};
