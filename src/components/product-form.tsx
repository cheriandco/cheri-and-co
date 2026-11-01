"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUSES: [string, string][] = [["draft", "Draft"], ["active", "Active"], ["low_stock", "Low stock"], ["archived", "Archived"]];

interface Values { sku: string; name: string; category: string; price: string; stock: string; status: string; channels: string }
const EMPTY: Values = { sku: "", name: "", category: "", price: "", stock: "", status: "draft", channels: "" };

/** Create (no productId) or edit (productId) a product. Only the fields the products table has. The organisation is never
 *  sent: the server takes it from the signed-in session. */
export function ProductForm({ productId, initial }: { productId?: string; initial?: Partial<Values> }) {
  const router = useRouter();
  const [v, setV] = useState<Values>({ ...EMPTY, ...initial });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const set = (k: keyof Values, val: string) => { setV((x) => ({ ...x, [k]: val })); setNotice(null); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(productId ? `/api/products/${productId}` : "/api/products", {
        method: productId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setNotice({ kind: "ok", text: productId ? "Product saved." : "Product added." });
        if (!productId) setV(EMPTY);
        router.refresh();
      } else {
        setNotice({ kind: "error", text: res.status === 400 ? "Check the fields: SKU and name are required, price and stock must be numbers of 0 or more." : json.error ?? "Something went wrong. Please try again." });
      }
    } catch {
      setNotice({ kind: "error", text: "Could not reach the server. Please try again." });
    }
    setBusy(false);
  }

  const id = productId ?? "new";
  return (
    <form onSubmit={save} noValidate>
      <div className="field"><label htmlFor={`p-name-${id}`}>Name</label>
        <input id={`p-name-${id}`} value={v.name} maxLength={200} onChange={(e) => set("name", e.target.value)} /></div>
      <div className="field"><label htmlFor={`p-sku-${id}`}>SKU</label>
        <input id={`p-sku-${id}`} value={v.sku} maxLength={64} onChange={(e) => set("sku", e.target.value)} /></div>
      <div className="field"><label htmlFor={`p-cat-${id}`}>Category</label>
        <input id={`p-cat-${id}`} value={v.category} maxLength={100} onChange={(e) => set("category", e.target.value)} /></div>
      <div className="field"><label htmlFor={`p-price-${id}`}>Price (₹)</label>
        <input id={`p-price-${id}`} inputMode="decimal" value={v.price} onChange={(e) => set("price", e.target.value)} placeholder="Leave blank if not set" /></div>
      <div className="field"><label htmlFor={`p-stock-${id}`}>Stock</label>
        <input id={`p-stock-${id}`} inputMode="numeric" value={v.stock} onChange={(e) => set("stock", e.target.value)} placeholder="Leave blank if not set" /></div>
      <div className="field"><label htmlFor={`p-status-${id}`}>Status</label>
        <select id={`p-status-${id}`} value={v.status} onChange={(e) => set("status", e.target.value)}>
          {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></div>
      <div className="field"><label htmlFor={`p-ch-${id}`}>Channels</label>
        <input id={`p-ch-${id}`} value={v.channels} onChange={(e) => set("channels", e.target.value)} placeholder="Comma separated, e.g. Website, Amazon" /></div>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : productId ? "Save changes" : "Add product"}</button>
      <div aria-live="polite" style={{ marginTop: 12 }}>
        {notice && <p role={notice.kind === "error" ? "alert" : "status"} style={{ margin: 0, fontSize: 13, color: notice.kind === "error" ? "var(--danger)" : "var(--sage)" }}>{notice.text}</p>}
      </div>
    </form>
  );
}
