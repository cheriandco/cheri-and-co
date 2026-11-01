/** The only module that asks Supabase who the caller is. Tests replace `createSupabaseServerClient`.
 *  Identity comes from the Auth server; organisation and role come from the `memberships` table, read through the
 *  caller's own RLS-protected session. Nothing the browser sends, and nothing in user-editable metadata, decides access. */
import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authRequired } from "./mode";
import { isRole, type Role } from "./roles";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** null when the account has no membership: such a user can sign in but can do nothing. */
  role: Role | null;
  orgId: string | null;
  /** True when the organisation is flagged is_demo. Only demo organisations may see the built-in sample data. */
  isDemoOrg: boolean;
}

/** What visitors are in demo mode: nobody is signed in, and the sample data is open by design. */
export const DEMO_USER: AuthUser = { id: "demo", email: "", name: "Anika", role: "owner", orgId: "demo", isDemoOrg: true };

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

interface MembershipRow { org_id: string; role: string; organizations: { is_demo: boolean } | { is_demo: boolean }[] | null }

/** Verified with the Auth server on every request (not just decoded from the cookie), so a signed-out or revoked
 *  session stops working immediately. Memoised per request. */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  if (!authRequired()) return DEMO_USER;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null; // not configured: fail closed
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const u = data.user;
  const email = u.email ?? "";

  const { data: rows } = await supabase
    .from("memberships")
    .select("org_id, role, organizations(is_demo)")
    .eq("user_id", u.id)
    .order("created_at", { ascending: true })
    .limit(1);
  const m = ((rows ?? []) as unknown as MembershipRow[])[0]; // cast: the client cannot infer the joined shape
  const org = Array.isArray(m?.organizations) ? m.organizations[0] : m?.organizations;
  const display = asString((u.user_metadata as Record<string, unknown> | undefined)?.full_name); // display only

  return {
    id: u.id,
    email,
    name: display ?? (email.split("@")[0] || "User"),
    role: m && isRole(m.role) ? m.role : null,
    orgId: m ? asString(m.org_id) : null,
    isDemoOrg: org?.is_demo === true,
  };
});
