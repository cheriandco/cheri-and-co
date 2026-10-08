import { LoadingSkeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div className="stack">
      <div className="skel" style={{ height: 56, width: "40%" }} />
      <LoadingSkeleton rows={1} height={120} />
      <LoadingSkeleton rows={3} height={80} />
    </div>
  );
}
