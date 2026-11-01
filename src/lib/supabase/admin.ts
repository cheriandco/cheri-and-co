/** Service-role client. It BYPASSES Row Level Security, so it is server-only and nothing imports it today.
 *  Use it only for work that no signed-in user may do for themselves (for example inviting a user), after the
 *  caller's permission has been checked with `requireAccess`, and always pass the organisation id from the
 *  verified session, never from the request. */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";

export function createSupabaseAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("The service-role client must never run in the browser");
  const cfg = supabaseConfig();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!cfg || !key) throw new Error("Supabase admin access is not configured");
  return createClient(cfg.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
