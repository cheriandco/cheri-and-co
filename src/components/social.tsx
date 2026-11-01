"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardCard, SectionHeader } from "./ui";
import { SOCIAL_PLATFORMS, type AssistMode, type AssistResult, type SocialPlatform } from "@/types/social";

type Values = { title: string; topic: string; platform: SocialPlatform; caption: string; hashtags: string; creativeBrief: string; imageDirection: string; scheduledFor: string };
const EMPTY: Values = { title: "", topic: "", platform: "Instagram", caption: "", hashtags: "#CheriAndCo", creativeBrief: "", imageDirection: "", scheduledFor: "" };

type Notice = { kind: "ok" | "error"; text: string; issues?: string[] } | null;

async function call<T>(url: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; issues?: string[] }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string; issues?: string[] };
    if (res.ok && json.data !== undefined) return { ok: true, data: json.data };
    return { ok: false, error: json.error ?? "Something went wrong. Please try again.", issues: json.issues };
  } catch {
    return { ok: false, error: "Could not reach the demo server. Please try again." };
  }
}

const ASSIST_BUTTONS: [AssistMode, string][] = [["ideas", "Post ideas"], ["caption", "Caption"], ["brief", "Creative brief"]];

export function PostComposer({ initial, postId }: { initial?: Partial<Values>; postId?: string }) {
  const router = useRouter();
  const [v, setV] = useState<Values>({ ...EMPTY, ...initial });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [assist, setAssist] = useState<AssistResult | null>(null);
  const [savedId, setSavedId] = useState<string | undefined>(postId);
  const set = <K extends keyof Values>(k: K, val: Values[K]) => { setV((x) => ({ ...x, [k]: val })); setNotice(null); };

  async function runAssist(mode: AssistMode) {
    setBusy(`assist-${mode}`); setNotice(null);
    const res = await call<AssistResult>("/api/social/assist", { mode, platform: v.platform, topic: v.topic || v.title, caption: v.caption });
    setBusy(null);
    if (res.ok) setAssist(res.data); else setNotice({ kind: "error", text: res.error });
  }

  async function save(): Promise<string | undefined> {
    const res = await call<{ id: string }>(savedId ? `/api/social/posts/${savedId}/edit` : "/api/social/posts", v);
    if (!res.ok) { setNotice({ kind: "error", text: res.error }); return undefined; }
    setSavedId(res.data.id);
    return res.data.id;
  }

  async function saveDraft() {
    setBusy("save");
    const id = await save();
    setBusy(null);
    if (id) { setNotice({ kind: "ok", text: "Draft saved in your private demo copy. Nothing has been posted." }); router.refresh(); }
  }

  async function submit() {
    setBusy("submit");
    const id = await save();
    if (!id) { setBusy(null); return; }
    const res = await call<unknown>(`/api/social/posts/${id}/submit`);
    setBusy(null);
    if (res.ok) { setNotice({ kind: "ok", text: "Sent to the approval queue (demo). Nothing has been posted." }); router.refresh(); }
    else setNotice({ kind: "error", text: res.error, issues: res.issues });
  }

  const applyText = (field: "caption" | "creativeBrief" | "imageDirection", text: string) => {
    const clean = field === "creativeBrief" ? text.replace(/^Creative brief:\s*/i, "") : field === "imageDirection" ? text.replace(/^Image direction:\s*/i, "") : text;
    set(field, clean);
  };

  return (
    <div className="grid even">
      <DashboardCard>
        <SectionHeader title={savedId ? "Edit post" : "Create a post"} extra={<span className="badge champagne plain">Demo · nothing is posted</span>} />
        <form onSubmit={(e) => { e.preventDefault(); void saveDraft(); }} noValidate>
          <div className="field"><label htmlFor="sp-title">Post title</label>
            <input id="sp-title" value={v.title} maxLength={120} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Everyday minimal stack" /></div>
          <div className="field"><label htmlFor="sp-topic">Topic</label>
            <input id="sp-topic" value={v.topic} maxLength={200} onChange={(e) => set("topic", e.target.value)} placeholder="What is this post about?" /></div>
          <div className="field"><label htmlFor="sp-platform">Platform</label>
            <select id="sp-platform" value={v.platform} onChange={(e) => set("platform", e.target.value as SocialPlatform)}>
              {SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></div>
          <div className="field"><label htmlFor="sp-date">Planned date</label>
            <input id="sp-date" type="date" value={v.scheduledFor} onChange={(e) => set("scheduledFor", e.target.value)} /></div>
          <div className="field"><label htmlFor="sp-caption">Caption</label>
            <textarea id="sp-caption" value={v.caption} maxLength={2200} onChange={(e) => set("caption", e.target.value)} /></div>
          <div className="field"><label htmlFor="sp-tags">Hashtags</label>
            <input id="sp-tags" value={v.hashtags} onChange={(e) => set("hashtags", e.target.value)} placeholder="#CheriAndCo #MinimalJewellery" /></div>
          <div className="field"><label htmlFor="sp-brief">Creative brief</label>
            <textarea id="sp-brief" value={v.creativeBrief} maxLength={1500} onChange={(e) => set("creativeBrief", e.target.value)} /></div>
          <div className="field"><label htmlFor="sp-image">Image direction</label>
            <textarea id="sp-image" value={v.imageDirection} maxLength={800} onChange={(e) => set("imageDirection", e.target.value)} /></div>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            <button type="submit" className="btn" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save draft"}</button>
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void submit()}>{busy === "submit" ? "Sending…" : "Submit for approval (demo)"}</button>
          </div>
          <div aria-live="polite" style={{ marginTop: 12 }}>
            {notice && (
              <p role={notice.kind === "error" ? "alert" : "status"} style={{ margin: 0, fontSize: 13, color: notice.kind === "error" ? "var(--danger)" : "var(--sage)" }}>
                {notice.text}{notice.kind === "ok" && <> <Link href="/content?tab=approvals">Open approvals</Link></>}
              </p>
            )}
            {notice?.issues && <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--danger)" }}>{notice.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          </div>
        </form>
      </DashboardCard>

      <DashboardCard tint>
        <SectionHeader title="AI content assistant" extra={<span className="badge champagne plain">Demo response</span>} />
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Template-based suggestions for the selected platform. No AI model is connected and nothing leaves this page. Fill in a topic, then choose what you want help with.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {ASSIST_BUTTONS.map(([mode, label]) => (
            <button key={mode} type="button" className="btn sm" disabled={busy !== null} onClick={() => void runAssist(mode)}>
              {busy === `assist-${mode}` ? "Working…" : label}
            </button>
          ))}
        </div>
        <div aria-live="polite" style={{ marginTop: 14 }}>
          {assist && (
            <div className="stack" style={{ gap: 10 }}>
              <span className="badge info plain">{assist.label}</span>
              {assist.warnings.length > 0 && (
                <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
                  Needs client-approved claims before it can be approved: {assist.warnings.join("; ")}
                </p>
              )}
              {assist.suggestions.map((s) => (
                <div key={s} className="card" style={{ padding: 12, boxShadow: "none" }}>
                  <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{s}</div>
                  {assist.mode === "caption" && <button type="button" className="btn sm ghost" onClick={() => applyText("caption", s)}>Use as caption</button>}
                  {assist.mode === "ideas" && <button type="button" className="btn sm ghost" onClick={() => { set("topic", s); }}>Use as topic</button>}
                  {assist.mode === "brief" && (
                    <button type="button" className="btn sm ghost" onClick={() => applyText(/^Image direction/i.test(s) ? "imageDirection" : "creativeBrief", s)}>
                      {/^Image direction/i.test(s) ? "Use as image direction" : "Use as creative brief"}
                    </button>
                  )}
                </div>
              ))}
              {assist.mode === "caption" && assist.hashtags.length > 0 && (
                <button type="button" className="btn sm ghost" onClick={() => set("hashtags", assist.hashtags.join(" "))}>Use hashtags: {assist.hashtags.join(" ")}</button>
              )}
            </div>
          )}
        </div>
      </DashboardCard>
    </div>
  );
}

/** Row actions for one post: edit is handled by the composer; this covers "simulate publish". */
export function SimulatePublish({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | { error: string }>("idle");
  return (
    <>
      <button type="button" className="btn sm" disabled={state === "busy"} onClick={async () => {
        setState("busy");
        const res = await call<unknown>(`/api/social/posts/${id}/publish`);
        if (res.ok) { setState("idle"); router.refresh(); } else setState({ error: res.error });
      }}>{state === "busy" ? "Working…" : "Simulate publish (demo)"}</button>
      {typeof state === "object" && <span role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{state.error}</span>}
    </>
  );
}
