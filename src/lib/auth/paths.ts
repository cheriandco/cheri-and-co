/** Route classification shared by the proxy and tests. Pure, no I/O. */

/** Pages reachable without a session. Everything else requires one. */
const PUBLIC_PAGES = ["/login"];

export const isPublicPage = (pathname: string): boolean => PUBLIC_PAGES.includes(pathname);
export const isApiPath = (pathname: string): boolean => pathname === "/api" || pathname.startsWith("/api/");

/** Accepts only same-site relative paths, so `?next=` cannot become an open redirect. */
export function safeNext(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return fallback;
  if (value === "/login" || value.startsWith("/login?")) return fallback;
  return value;
}
