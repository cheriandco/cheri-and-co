import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="card">
      <EmptyState title="We couldn’t find that page" hint="It may have moved or no longer exists." action={<Link className="btn primary" href="/dashboard">Back to dashboard</Link>} />
    </div>
  );
}
