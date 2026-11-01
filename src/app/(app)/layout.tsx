import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell";
import { authRequired } from "@/lib/auth/mode";
import { getAuthUser } from "@/lib/auth/session";
import { getCurrentUser, getNotifications, getSearchIndex, getApprovals } from "@/services";
import { signOutAction } from "@/app/login/actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const required = authRequired();
  if (required) {
    // The proxy already redirects signed-out visitors; this re-checks on the server and handles accounts that are
    // signed in but have no organisation membership yet.
    const auth = await getAuthUser();
    if (!auth) redirect("/login");
    if (!auth.role) {
      return (
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
          <div className="card" style={{ width: "100%", maxWidth: 420 }}>
            <h1 style={{ fontSize: 20, marginBottom: 6 }}>No workspace available yet</h1>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              Your account is not a member of any organisation. Ask the administrator to add you.
            </p>
            <form action={signOutAction}><button className="btn" type="submit">Sign out</button></form>
          </div>
        </main>
      );
    }
  }
  const [user, notifications, searchIndex, approvals] = await Promise.all([
    getCurrentUser(), getNotifications(), getSearchIndex(), getApprovals(),
  ]);
  const pending = approvals.filter((a) => a.status === "pending").length;
  return (
    <AppShell user={user} notifications={notifications} searchIndex={searchIndex} pending={pending} canSignOut={required}>
      {children}
    </AppShell>
  );
}
