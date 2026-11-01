/** First line of defence (optimistic): in required mode it refreshes the Supabase session, sends signed-out visitors
 *  to /login and answers signed-out API calls with 401. Real authorization happens again in route handlers and the
 *  data layer (src/lib/auth/access.ts); this file alone is never relied on. Fails closed when Supabase is not
 *  configured. In demo mode (the default) it does nothing, so the public demo is unchanged. */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authRequired } from "@/lib/auth/mode";
import { isApiPath, isPublicPage } from "@/lib/auth/paths";
import { supabaseConfig } from "@/lib/supabase/config";

type CookieList = { name: string; value: string; options?: Record<string, unknown> }[];

export async function proxy(request: NextRequest) {
  if (!authRequired()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const cfg = supabaseConfig();

  let response = NextResponse.next({ request });
  let signedIn = false;

  if (cfg) {
    const supabase = createServerClient(cfg.url, cfg.anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: CookieList) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  }

  const carryCookies = (to: NextResponse) => {
    response.cookies.getAll().forEach((c) => to.cookies.set(c));
    return to;
  };

  if (!signedIn && !isPublicPage(pathname)) {
    if (isApiPath(pathname)) {
      return carryCookies(NextResponse.json({ error: "Authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } }));
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return carryCookies(NextResponse.redirect(url));
  }

  if (signedIn && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return carryCookies(NextResponse.redirect(url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|brand/).*)"],
};
