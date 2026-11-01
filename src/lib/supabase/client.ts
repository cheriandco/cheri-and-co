/** Supabase client for the browser. Anon key only; it can do nothing Row Level Security does not allow.
 *  Nothing in the app uses it yet (sign-in runs in a Server Action) and it is here for client-side features later. */
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";

export function createSupabaseBrowserClient(): SupabaseClient | null {
  const cfg = supabaseConfig();
  return cfg ? createBrowserClient(cfg.url, cfg.anonKey) : null;
}
