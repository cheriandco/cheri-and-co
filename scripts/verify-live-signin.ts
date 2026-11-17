/** Read-only sign-in check for the hosted Supabase project. Run by the project owner, on their own machine.
 *
 *  Run (PowerShell, from the repo root):
 *    node --env-file=.env.local scripts/verify-live-signin.ts
 *
 *  What it does: asks for the test account's email and password at the prompt (the password is typed hidden and is
 *  never written to disk, a log or a file), signs in with the public anon key, reads what that user is allowed to see
 *  through Row Level Security, prints COUNTS only (never row contents, tokens or the password), then signs out.
 *  It performs no insert, update or delete.
 *
 *  It reads only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from the environment. It does not read any
 *  other variable. Exit code 0 = every check passed, 1 = a check failed, 2 = could not run. */
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
if (!url || !anonKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Run with --env-file=.env.local");
  process.exit(2);
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hidden input: swallow everything readline would echo after the prompt has been shown.
    const out = rl as unknown as { _writeToOutput: (s: string) => void }; // cast: readline exposes no public mute option
    const original = out._writeToOutput.bind(rl);
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!hidden || !prompted) { prompted = true; original(s); }
    };
    rl.on("close", () => resolve("")); // input ended (Ctrl+C or no terminal): resolve empty so the run stops with exit code 2, never 0
    rl.question(question, (answer) => { if (hidden) process.stdout.write("\n"); resolve(answer.trim()); rl.close(); });
  });
}

type Row = { check: string; ok: boolean; detail: string };
const rows: Row[] = [];
const record = (check: string, ok: boolean, detail: string) => { rows.push({ check, ok, detail }); };

const TABLES = ["customers", "products", "retailers", "leads", "tasks", "approvals", "orders", "content_items", "agent_activity", "audit_log"] as const;

async function main(): Promise<number> {
  console.log(`Project: ${new URL(url!).host}`);
  const email = await ask("Test account email: ", false);
  const password = await ask("Password (hidden): ", true);
  if (!email || !password) { console.error("Email and password are required."); return 2; }

  const supabase = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.user) {
    record("1 sign-in with the correct password", false, "refused (generic): check the email and password");
    return report(1);
  }
  record("1 sign-in with the correct password", true, "accepted");
  const userId = signedIn.data.user.id;

  // Membership and organisation, as the app reads them (src/lib/auth/session.ts).
  const mem = await supabase.from("memberships").select("org_id, role, organizations(is_demo)").eq("user_id", userId);
  const memberships = (mem.data ?? []) as unknown as { org_id: string; role: string; organizations: { is_demo: boolean } | { is_demo: boolean }[] | null }[];
  record("2 the account has a membership", !mem.error && memberships.length >= 1, mem.error ? `error ${mem.error.code}` : `${memberships.length} membership(s)`);
  const first = memberships[0];
  if (first) {
    const org = Array.isArray(first.organizations) ? first.organizations[0] : first.organizations;
    record("3 role is a known role", ["owner", "admin", "approver", "staff", "viewer"].includes(first.role), `role = ${first.role}`);
    record("4 organisation is a live one (is_demo = false)", org?.is_demo === false, `is_demo = ${String(org?.is_demo)}`);
  }

  // Isolation: the user must see exactly one organisation and no other user's membership (unless owner/admin of the same org).
  const orgs = await supabase.from("organizations").select("id", { count: "exact", head: true });
  record("5 sees exactly one organisation", !orgs.error && orgs.count === 1, orgs.error ? `error ${orgs.error.code}` : `${orgs.count} visible`);
  const foreign = first
    ? await supabase.from("customers").select("id", { count: "exact", head: true }).neq("org_id", first.org_id)
    : null;
  record("6 sees zero customers of any other organisation", !!foreign && !foreign.error && foreign.count === 0, foreign ? (foreign.error ? `error ${foreign.error.code}` : `${foreign.count} visible`) : "no membership");

  // Table reachability under the user's own session (counts only).
  for (const t of TABLES) {
    const r = await supabase.from(t).select("*", { count: "exact", head: true });
    record(`7 can read ${t}`, !r.error, r.error ? `error ${r.error.code}` : `${r.count ?? 0} row(s)`);
  }

  // The private helper schema must not be reachable from the API.
  const priv = await supabase.schema("private" as never).from("memberships" as never).select("*").limit(1);
  record("8 the private schema is not exposed", !!priv.error, priv.error ? "refused (good)" : "REACHABLE (bad)");

  await supabase.auth.signOut();
  const after = await supabase.auth.getUser();
  record("9 after sign-out the session is gone", !after.data.user, after.data.user ? "still signed in" : "signed out");

  return report(rows.some((r) => !r.ok) ? 1 : 0);
}

function report(code: number): number {
  console.log("");
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}  (${r.detail})`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\nALL ${rows.length} CHECKS PASSED` : `\n${failed} OF ${rows.length} CHECKS FAILED`);
  return code;
}

main().then((c) => process.exit(c), (e: unknown) => { console.error("Could not run:", e instanceof Error ? e.message : "unknown error"); process.exit(2); });
