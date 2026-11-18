"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardCard, SectionHeader } from "./ui";
import { KIND_META, STUDIO_KINDS, type StudioKind } from "@/lib/content-studio/kinds";
import { AUDIENCES } from "@/types/content-agent";
import type { Audience } from "@/types/content-agent";
import type { ContentPlatform, SocialPostView } from "@/types/social";

export interface StudioProductOption { id: string; name: string; category: string; description: string | null; imageUrl: string | null }

const AUDIENCE_LABEL: Record<Audience, string> = { everyday: "Everyday", college: "College", work: "Working professionals", gifting: "Gifting" };

interface Draft { id: string; platform: ContentPlatform; topic: string; title: string; caption: string; hashtags: string; creativeBrief: string; imageDirection: string; scheduledFor: string; status: SocialPostView["status"] }
type Notice = { kind: "ok" | "error"; text: string; issues?: string[] } | null;

const toDraft = (p: SocialPostView): Draft => ({
  id: p.id, platform: p.platform, topic: p.topic, title: p.title, caption: p.caption, hashtags: p.hashtags.join(" "), creativeBrief: p.creativeBrief,
  imageDirection: p.imageDirection, scheduledFor: p.scheduledFor, status: p.status,
});

async function call<T>(url: string, body?: unknown): Promise<{ ok: true; json: T } | { ok: false; error: string; issues?: string[] }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: string[] };
    return res.ok ? { ok: true, json } : { ok: false, error: json.error ?? `The server returned an error (HTTP ${res.status}) with no details. The server log has the cause.`, issues: json.issues };
  } catch {
    return { ok: false, error: "Could not reach the server. Please try again." };
  }
}

/** Product -> generate -> edit -> regenerate -> send for approval. Everything is a draft: nothing is published, and the person decides in Approvals. */
export function ContentStudio({ products, aiOn }: { products: StudioProductOption[]; aiOn: boolean }) {
  const router = useRouter();
  const [productId, setProductId] = useState("");
  const [kind, setKind] = useState<StudioKind>("instagram_caption");
  const [audience, setAudience] = useState<Audience>("everyday");
  const [theme, setTheme] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"gen" | "save" | "submit" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [source, setSource] = useState<{ generator: "openai" | "template"; note: string } | null>(null);

  const product = products.find((p) => p.id === productId);
  const locked = draft !== null && draft.status !== "draft" && draft.status !== "rejected";
  const setField = <K extends keyof Draft>(k: K, v: Draft[K]) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setNotice(null); };

  async function generate(regenerate: boolean) {
    if (!product) { setNotice({ kind: "error", text: "Choose a product first." }); return; }
    setBusy("gen"); setNotice(null);
    const res = await call<{ data: SocialPostView; generator: "openai" | "template"; note: string }>("/api/content-studio/generate", {
      productId, kind, audience, theme: theme.trim() || undefined, postId: regenerate && draft ? draft.id : undefined,
    });
    setBusy(null);
    if (!res.ok) { setNotice({ kind: "error", text: res.error }); return; }
    setDraft(toDraft(res.json.data));
    setSource({ generator: res.json.generator, note: res.json.note });
    setNotice({ kind: "ok", text: regenerate ? "Draft regenerated and saved." : "Draft generated and saved. Nothing has been posted." });
    router.refresh();
  }

  async function save(): Promise<boolean> {
    if (!draft) return false;
    const res = await call<unknown>(`/api/social/posts/${draft.id}/edit`, {
      title: draft.title, topic: draft.topic, platform: draft.platform, caption: draft.caption, hashtags: draft.hashtags,
      creativeBrief: draft.creativeBrief, imageDirection: draft.imageDirection, scheduledFor: draft.scheduledFor || undefined,
    });
    if (!res.ok) { setNotice({ kind: "error", text: res.error, issues: res.issues }); return false; }
    return true;
  }

  async function saveEdits() {
    setBusy("save");
    const ok = await save();
    setBusy(null);
    if (ok) { setNotice({ kind: "ok", text: "Edits saved. Nothing has been posted." }); router.refresh(); }
  }

  async function submit() {
    if (!draft) return;
    setBusy("submit");
    if (!(await save())) { setBusy(null); return; }
    const res = await call<{ data: SocialPostView }>(`/api/social/posts/${draft.id}/submit`);
    setBusy(null);
    if (!res.ok) { setNotice({ kind: "error", text: res.error, issues: res.issues }); return; }
    setDraft((d) => (d ? { ...d, status: res.json.data.status } : d));
    setNotice({ kind: "ok", text: "Sent to the approval queue. Nothing has been posted." });
    router.refresh();
  }

  return (
    <div className="grid even">
      <DashboardCard>
        <SectionHeader title="Draft from a product" extra={<span className={`badge ${aiOn ? "champagne" : "plain"}`}>{aiOn ? "AI drafting on" : "AI off · template drafts"}</span>} />
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Drafts use your catalogue record (name, category, description) and the Brand Brain. {aiOn ? "The AI writes only the copy; code adds the brand line and hashtags." : "AI drafting is switched off, so drafts are built from a template. Turn it on only after the owner approves a live test."} No customer information is ever sent. A person approves every draft; nothing is posted.
        </p>
        <div className="field"><label htmlFor="cs-product">Product</label>
          <select id="cs-product" value={productId} onChange={(e) => { setProductId(e.target.value); setNotice(null); }}>
            <option value="">Choose a product…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        {product && (
          <p className="muted" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>
            {product.category || "No category"} · {product.description ? "Description on file" : "No description yet (drafts will be short)"} · {product.imageUrl ? "Image link on file (kept as a reference; the AI does not see it)" : "No image link"}
          </p>
        )}
        <div className="field"><label htmlFor="cs-kind">Content type</label>
          <select id="cs-kind" value={kind} onChange={(e) => setKind(e.target.value as StudioKind)}>
            {STUDIO_KINDS.map((k) => <option key={k} value={k}>{KIND_META[k].label} → {KIND_META[k].savedAs}</option>)}
          </select></div>
        <div className="field"><label htmlFor="cs-audience">Audience</label>
          <select id="cs-audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
            {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
          </select></div>
        <div className="field"><label htmlFor="cs-theme">Campaign note (optional)</label>
          <input id="cs-theme" value={theme} maxLength={200} onChange={(e) => setTheme(e.target.value)} placeholder="e.g. A calm, everyday look. No names, numbers or links." /></div>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn primary" disabled={busy !== null || !productId} onClick={() => void generate(false)}>{busy === "gen" && !draft ? "Drafting…" : "Generate draft"}</button>
        </div>
        {notice && !draft && <p role={notice.kind === "error" ? "alert" : "status"} style={{ fontSize: 13, color: notice.kind === "error" ? "var(--danger)" : "var(--sage)" }}>{notice.text}</p>}
      </DashboardCard>

      <DashboardCard tint>
        <SectionHeader title={draft ? "Your draft" : "Draft"} extra={draft ? <span className="badge info plain">{locked ? draft.status.replace("_", " ") : "Draft · not posted"}</span> : undefined} />
        {!draft && <p className="muted" style={{ fontSize: 13 }}>Choose a product and a content type, then generate. The draft appears here, ready to edit.</p>}
        {draft && (
          <form onSubmit={(e) => { e.preventDefault(); void saveEdits(); }} noValidate>
            {source && <p className="muted" style={{ margin: "0 0 10px", fontSize: 12.5 }}><span className={`badge ${source.generator === "openai" ? "champagne" : "plain"}`}>{source.generator === "openai" ? "AI-written · review every line" : "Template"}</span> {source.note}</p>}
            <div className="field"><label htmlFor="cd-title">Title</label>
              <input id="cd-title" value={draft.title} maxLength={120} disabled={locked} onChange={(e) => setField("title", e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-caption">{draft.platform === "Amazon A+" ? "Description" : "Copy"}</label>
              <textarea id="cd-caption" rows={8} value={draft.caption} maxLength={2200} disabled={locked} onChange={(e) => setField("caption", e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-tags">Hashtags</label>
              <input id="cd-tags" value={draft.hashtags} disabled={locked} onChange={(e) => setField("hashtags", e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-brief">Brief</label>
              <textarea id="cd-brief" rows={2} value={draft.creativeBrief} maxLength={1500} disabled={locked} onChange={(e) => setField("creativeBrief", e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-image">Image direction</label>
              <textarea id="cd-image" rows={2} value={draft.imageDirection} maxLength={800} disabled={locked} onChange={(e) => setField("imageDirection", e.target.value)} /></div>
            {!locked && (
              <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
                <button type="submit" className="btn" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save edits"}</button>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => void generate(true)}>{busy === "gen" ? "Regenerating…" : "Regenerate (replaces this text)"}</button>
                <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void submit()}>{busy === "submit" ? "Sending…" : "Submit for approval"}</button>
              </div>
            )}
            {locked && <p className="muted" style={{ fontSize: 13 }}>This draft is {draft.status.replace("_", " ")}. Decide it in <Link href="/approvals">Approvals</Link>; nothing is posted by this app.</p>}
            <div aria-live="polite" style={{ marginTop: 12 }}>
              {notice && (
                <p role={notice.kind === "error" ? "alert" : "status"} style={{ margin: 0, fontSize: 13, color: notice.kind === "error" ? "var(--danger)" : "var(--sage)" }}>
                  {notice.text}{notice.kind === "ok" && <> <Link href="/content?tab=approvals">Open approvals</Link></>}
                </p>
              )}
              {notice?.issues && <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--danger)" }}>{notice.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
            </div>
          </form>
        )}
      </DashboardCard>
    </div>
  );
}
