"use server";

import { redirect } from "next/navigation";
import { authRequired } from "@/lib/auth/mode";
import { safeNext } from "@/lib/auth/paths";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface LoginState { error: string | null }

/** Email + password sign-in. The same generic message is returned for every failure so the form does not reveal
 *  which emails exist. There is no sign-up action: accounts are created by an administrator in Supabase. */
export async function signInAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (!authRequired()) return { error: "Sign-in is switched off in the demo." };
  const email = String(form.get("email") ?? "").trim().slice(0, 254);
  const password = String(form.get("password") ?? "").slice(0, 200);
  const next = safeNext(form.get("next"));
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Sign-in is not available yet. Ask the administrator to finish setup." };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Incorrect email or password." };
  redirect(next);
}

/** Ends the session on the Auth server (global scope: every device) and clears the cookies. */
export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut({ scope: "global" });
  redirect("/login");
}
