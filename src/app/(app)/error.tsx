"use client";

import { ErrorState } from "@/components/states";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState title="Something went wrong" hint="We couldn’t load this page. Your data is safe." onRetry={reset} />;
}
