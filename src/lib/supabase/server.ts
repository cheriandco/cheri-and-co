/** Supabase client for Server Components, Route Handlers and Server Actions. It acts as the signed-in user (anon key
 *  plus the session cookie), so Row Level Security applies to everything it does. */
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseConfig } from "./config";

type CookieList = { name: string; value: string; options?: Record<string, unknown> }[];

export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  const store = await cookies();
  return createServerClient(cfg.url, cfg.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      // Server Components cannot set cookies; the proxy refreshes the session, so ignoring that is safe.
      setAll: (list: CookieList) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* read-only context */ }
      },
    },
  });
}
