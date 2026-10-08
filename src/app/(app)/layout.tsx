import { AppShell } from "@/components/shell";
import { getCurrentUser, getNotifications, getSearchIndex, getApprovals } from "@/services";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, notifications, searchIndex, approvals] = await Promise.all([
    getCurrentUser(), getNotifications(), getSearchIndex(), getApprovals(),
  ]);
  const pending = approvals.filter((a) => a.status === "pending").length;
  return (
    <AppShell user={user} notifications={notifications} searchIndex={searchIndex} pending={pending}>
      {children}
    </AppShell>
  );
}
