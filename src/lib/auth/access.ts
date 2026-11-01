/** Authorization decisions. Every protected read or write passes through `requireAccess`, in addition to the proxy.
 *  In demo mode it allows everything (the public sample demo); in required mode it fails closed. */
import { NextResponse } from "next/server";
import { authRequired } from "./mode";
import { can, type Permission } from "./roles";
import { getAuthUser, type AuthUser } from "./session";

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Throws AuthError unless the caller is signed in, holds the permission, and belongs to an organisation that may see
 *  the built-in sample data. (Until tenant data is moved into Supabase, the sample data is the only dataset and it is
 *  visible only to members of an organisation flagged is_demo; every other organisation is denied.) */
export async function requireAccess(permission: Permission): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) throw new AuthError(401, "Authentication required");
  if (!can(user.role, permission)) throw new AuthError(403, "You do not have permission to do this");
  if (!user.isDemoOrg) throw new AuthError(403, "This organisation has no data source yet");
  return user;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Browser writes must come from this site and be JSON. With SameSite cookies this blocks cross-site form posts. */
export function csrfProblem(req: Request): string | null {
  if (SAFE_METHODS.has(req.method)) return null;
  const origin = req.headers.get("origin");
  if (!origin) return null; // browsers always send Origin on writes, so this is not a browser acting on cookies
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  let originHost = "";
  try { originHost = new URL(origin).host; } catch { /* malformed, e.g. "null" */ }
  if (originHost !== host) return "Cross-site request blocked";
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return "Content-Type must be application/json";
  return null;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** First line of every API handler: `const denied = await deny("data:read", req); if (denied) return denied;`
 *  Returns a ready-made 401/403 response, or null when the caller may proceed. */
export async function deny(permission: Permission, req?: Request): Promise<NextResponse | null> {
  try {
    await requireAccess(permission); // 401 before anything about the request is examined
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    throw e;
  }
  const problem = authRequired() && req ? csrfProblem(req) : null;
  return problem ? NextResponse.json({ error: problem }, { status: 403, headers: NO_STORE }) : null;
}

/** Audit actor: the server-verified identity, never a value from the request. */
export const actorOf = (user: AuthUser): string => user.email || user.id;

/** Who is acting, for audit entries. Demo visitors are all shown as the sample founder, "Anika". */
export async function currentActor(): Promise<string> {
  const user = await getAuthUser();
  return !authRequired() || !user ? "Anika" : actorOf(user);
}
