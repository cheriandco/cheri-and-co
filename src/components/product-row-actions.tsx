"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "./interactive";

/** Edit and Delete for one row of the Products list. Edit opens the product's page, which holds the existing edit form.
 *  Delete asks first, names the product, and sends nothing until the person confirms. The organisation is never sent: the server takes
 *  it from the session, and the database's row-level security has the last word. */
export function ProductRowActions({ id, name, canEdit, canDelete }: { id: string; name: string; canEdit: boolean; canDelete: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => { if (!busy) { setOpen(false); setError(null); } };

  async function remove() {
    setBusy(true); setError(null);
    try {
      // The content-type header is required on every write by the server's cross-site check, even without a body.
      const res = await fetch(`/api/products/${id}`, { method: "DELETE", headers: { "content-type": "application/json" } });
      if (res.ok || res.status === 404) { // 404: already gone, so the list is simply refreshed
        setOpen(false);
        router.refresh();
      } else if (res.status === 403) {
        setError("Only an owner or admin can delete products.");
      } else {
        setError("Could not delete this product. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setBusy(false);
  }

  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      {canEdit && <Link className="btn sm" href={`/products/${id}`} aria-label={`Edit ${name}`}>Edit</Link>}
      {canDelete && <button type="button" className="btn sm danger" aria-label={`Delete ${name}`} onClick={() => setOpen(true)}>Delete</button>}
      {open && (
        <ConfirmDialog title="Delete this product?" confirmLabel={busy ? "Deleting…" : "Delete product"} danger busy={busy} onConfirm={remove} onCancel={close}>
          <p style={{ margin: "8px 0 0" }}><strong>{name}</strong> will be permanently removed from your catalogue. This cannot be undone.</p>
          {error && <p role="alert" style={{ margin: "12px 0 0", fontSize: 13, color: "var(--danger)" }}>{error}</p>}
        </ConfirmDialog>
      )}
    </span>
  );
}
