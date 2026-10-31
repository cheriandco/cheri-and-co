"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardCard, SectionHeader } from "./ui";
import { ErrorState } from "./states";
import { requestDraft, submitDraft, type ContentFormValues, type ContentPanelState } from "@/lib/content-agent/client";
import { WORKFLOW_LABEL } from "@/lib/content-agent/workflow";
import { AUDIENCES } from "@/types/content-agent";
import type { Audience, ContentDraft, ContentPack, ContentProduct } from "@/types/content-agent";

const AUDIENCE_LABEL: Record<Audience, string> = { everyday: "Everyday", college: "College", work: "Working professionals", gifting: "Gifting" };

type Props = { products: ContentProduct[]; packs: ContentPack[]; note: string };
type Sent = "idle" | "sending" | "sent" | { error: string };

export function ContentAgentPanel({ products, packs, note }: Props) {
  const [values, setValues] = useState<ContentFormValues>({ target: "", audience: "everyday", amazonUrl: "", flipkartUrl: "" });
  const [state, setState] = useState<ContentPanelState>({ status: "idle" });
  const [sent, setSent] = useState<Sent>("idle");
  const router = useRouter();
  const loading = state.status === "loading";

  async function run() {
    if (loading) return;
    setState({ status: "loading" });
    setSent("idle");
    setState(await requestDraft(values));
  }

  async function submit(v: ContentFormValues) {
    setSent("sending");
    const res = await submitDraft(v);
    if (res.ok) { setSent("sent"); router.refresh(); } else setSent({ error: res.message });
  }

  const set = <K extends keyof ContentFormValues>(k: K, v: ContentFormValues[K]) => setValues((x) => ({ ...x, [k]: v }));

  return (
    <DashboardCard>
      <SectionHeader title="Try the Content & Marketing Agent" extra={<span className="badge champagne plain">Prototype · SAMPLE data</span>} />
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Drafts captions, scripts, stories and Canva briefs from SAMPLE records. {note} Nothing is posted to Instagram, Amazon, Flipkart or anywhere else; approval only records a decision.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} noValidate>
        <div className="field">
          <label htmlFor="ca-target">Product or combo pack</label>
          <select id="ca-target" value={values.target} onChange={(e) => set("target", e.target.value)}>
            <option value="">Choose a SAMPLE record…</option>
            <optgroup label="Single pieces (SAMPLE)">
              {products.map((p) => <option key={p.id} value={`product:${p.id}`}>{p.name} · {p.id}</option>)}
            </optgroup>
            <optgroup label="Combo packs (SAMPLE)">
              {packs.map((p) => <option key={p.id} value={`pack:${p.id}`}>{p.name} · {p.size}-piece · {p.id}</option>)}
            </optgroup>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ca-audience">Audience</label>
          <select id="ca-audience" value={values.audience} onChange={(e) => set("audience", e.target.value as Audience)}>
            {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ca-amazon">Amazon link (optional)</label>
          <input id="ca-amazon" type="url" inputMode="url" value={values.amazonUrl} placeholder="https://www.amazon.in/…" onChange={(e) => set("amazonUrl", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ca-flipkart">Flipkart link (optional)</label>
          <input id="ca-flipkart" type="url" inputMode="url" value={values.flipkartUrl} placeholder="https://www.flipkart.com/…" onChange={(e) => set("flipkartUrl", e.target.value)} />
        </div>
        {state.status === "invalid" && <p role="alert" style={{ color: "var(--danger)", fontSize: 12.5 }}>{state.message}</p>}
        <button type="submit" className="btn primary" disabled={loading}>{loading ? "Drafting…" : "Draft content (simulated)"}</button>
      </form>

      <div aria-live="polite" style={{ marginTop: 18 }}>
        {loading && <p className="muted" role="status">Drafting from the SAMPLE record…</p>}
        {state.status === "error" && <ErrorState title="Drafting failed" hint={state.message} onRetry={() => void run()} />}
        {state.status === "done" && <DraftView draft={state.draft} note={state.note} sent={sent} onSubmit={() => void submit(state.values)} />}
      </div>
    </DashboardCard>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="eyebrow">{title}</div>{children}</div>;
}

function DraftView({ draft: d, note, sent, onSubmit }: { draft: ContentDraft; note?: string; sent: Sent; onSubmit: () => void }) {
  const notes = d.issues.filter((i) => i.severity !== "info");
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="badge info">{WORKFLOW_LABEL[d.status]}</span>
        {d.subject.isSample && <span className="badge champagne">SAMPLE data · not for publishing</span>}
        <span className="badge plain">Not published</span>
        {d.blocked && <span className="badge danger">Blocked</span>}
      </div>
      {note && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{note}</p>}

      {notes.length > 0 && (
        <Block title="Review notes">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {notes.map((n, i) => <li key={i} style={{ color: n.severity === "error" ? "var(--danger)" : undefined }}>{n.message}</li>)}
          </ul>
        </Block>
      )}

      <Block title="Instagram caption">
        <div className="bubble out" style={{ maxWidth: "100%", whiteSpace: "pre-wrap" }}>{d.instagramCaption}</div>
      </Block>
      <Block title={`${d.reelScript.title} (${d.reelScript.durationSeconds}s)`}>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {d.reelScript.scenes.map((s) => <li key={s.time}><b style={{ fontWeight: 500 }}>{s.time}</b> {s.visual}{s.onScreenText && <span className="muted"> · on-screen: {s.onScreenText}</span>}</li>)}
        </ul>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>{d.reelScript.audioNote}</p>
      </Block>
      <Block title={`${d.asmrScript.title} (${d.asmrScript.durationSeconds}s)`}>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {d.asmrScript.cues.map((c) => <li key={c.time}><b style={{ fontWeight: 500 }}>{c.time}</b> {c.visual}<span className="muted"> · sound: {c.sound}</span></li>)}
        </ul>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>{d.asmrScript.note}</p>
      </Block>
      <Block title="Story">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {d.story.map((f) => <li key={f.frame}>Frame {f.frame}: {f.visual}<span className="muted"> · text: {f.text}</span>{f.sticker && <div className="muted">{f.sticker}</div>}</li>)}
        </ul>
      </Block>
      <Block title="Canva design brief">
        <dl className="kv" style={{ fontSize: 13 }}>
          <dt>Formats</dt><dd>{d.canvaBrief.formats.map((f) => `${f.name} ${f.size}`).join(" · ")}</dd>
          <dt>Headline</dt><dd>{d.canvaBrief.headline}</dd>
          <dt>Supporting</dt><dd>{d.canvaBrief.supportingText}</dd>
          <dt>Layout</dt><dd>{d.canvaBrief.layout}</dd>
          <dt>Palette</dt><dd>{d.canvaBrief.palette}</dd>
          <dt>Imagery</dt><dd>{d.canvaBrief.imagery}</dd>
          <dt>Avoid</dt><dd>{d.canvaBrief.avoid.join(" · ")}</dd>
        </dl>
      </Block>
      <Block title="What this draft used">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{d.factsUsed.join(" · ")}</p>
      </Block>

      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <button type="button" className="btn primary" disabled={d.blocked || sent === "sending" || sent === "sent"} onClick={onSubmit}>
          {sent === "sending" ? "Sending…" : sent === "sent" ? "Sent for review" : "Send to review queue"}
        </button>
        {sent === "sent" && <span className="muted" style={{ fontSize: 13 }}>Pending review in <Link href="/approvals">Approvals</Link>. Nothing has been published.</span>}
        {typeof sent === "object" && <span role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{sent.error}</span>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>{d.dataSource.note}</p>
    </div>
  );
}
