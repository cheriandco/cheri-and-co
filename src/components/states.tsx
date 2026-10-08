"use client";

import { AlertCircle } from "lucide-react";
import { Butterfly } from "./ui";

export function ErrorState({ title, hint, onRetry }: { title: string; hint?: string; onRetry?: () => void }) {
  return (
    <div className="card empty" role="alert">
      <Butterfly size={34} />
      <h3><AlertCircle size={18} style={{ verticalAlign: -3, color: "var(--danger)" }} /> {title}</h3>
      {hint && <p>{hint}</p>}
      {onRetry && <button className="btn primary" onClick={onRetry}>Retry</button>}
    </div>
  );
}
