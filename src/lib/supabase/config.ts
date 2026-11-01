/** Supabase settings read from the environment. The URL and anon key are public by design (Row Level Security is the
 *  protection); they use the NEXT_PUBLIC_ prefix so the browser client can read them. The service-role key is a
 *  different thing: it bypasses RLS, is read only by `admin.ts`, and must never get a NEXT_PUBLIC_ prefix. */
export interface SupabaseConfig { url: string; anonKey: string }

export function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

export const isSupabaseConfigured = (): boolean => supabaseConfig() !== null;
