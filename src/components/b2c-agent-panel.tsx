"use client";

import { useState } from "react";
import { DashboardCard, SectionHeader } from "./ui";
import { ErrorState } from "./states";
import { requestAgent, MAX_ENQUIRY_LENGTH, type PanelState } from "@/lib/b2c-agent/client";
import type { B2CIntent } from "@/types/b2c-agent";

const INTENT_LABEL: Record<B2CIntent, string> = {
  product_recommendation: "Product recommendation", price_enquiry: "Price enquiry", product_details: "Product details",
  occasion_style_recommendation: "Occasion / style recommendation", availability_enquiry: "Availability enquiry",
  purchase_link_request: "Purchase link request", order_status: "Order status", return_refund: "Return / refund",
  return_policy_enquiry: "Return policy enquiry", shipping_enquiry: "Shipping enquiry", discount_enquiry: "Discount / offer enquiry",
  complaint: "Complaint", other: "Other / unclear",
};

const EXAMPLES = ["Can you recommend minimal earrings for daily wear under ₹1500?", "How much is the Kundan Choker Necklace?", "Where is my order?"];

export function B2CAgentPanel() {
  const [text, setText] = useState("");
  const [state, setState] = useState<PanelState>({ status: "idle" });

  async function run() {
    if (state.status === "loading") return;
    setState({ status: "loading" });
    setState(await requestAgent(text));
  }

  const loading = state.status === "loading";
  return (
    <DashboardCard>
      <SectionHeader title="Try the B2C Sales Agent" extra={<span className="badge champagne plain">Prototype · sample data</span>} />
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Simulated run on a sample catalogue. Products, prices and availability are illustrative, and nothing is sent to any customer.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} noValidate>
        <div className="field">
          <label htmlFor="b2c-enquiry">Customer enquiry</label>
          <textarea id="b2c-enquiry" value={text} maxLength={MAX_ENQUIRY_LENGTH} onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Can you suggest a necklace for a wedding under ₹6000?" aria-invalid={state.status === "invalid"} aria-describedby={state.status === "invalid" ? "b2c-enquiry-error" : undefined} />
          {state.status === "invalid" && <span id="b2c-enquiry-error" role="alert" style={{ color: "var(--danger)", fontSize: 12.5 }}>{state.message}</span>}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <button type="submit" className="btn primary" disabled={loading}>{loading ? "Running agent…" : "Run agent (simulated)"}</button>
          {EXAMPLES.map((ex) => <button key={ex} type="button" className="chip" onClick={() => setText(ex)} disabled={loading}>{ex}</button>)}
        </div>
      </form>

      <div aria-live="polite" style={{ marginTop: 18 }}>
        {loading && <p className="muted" role="status">Running the agent on the sample catalogue…</p>}
        {state.status === "error" && <ErrorState title="Agent run failed" hint={state.message} onRetry={() => void run()} />}
        {state.status === "done" && <AgentResult result={state.result} />}
      </div>
    </DashboardCard>
  );
}

function AgentResult({ result: r }: { result: Extract<PanelState, { status: "done" }>["result"] }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="badge info">{INTENT_LABEL[r.intent]} · {Math.round(r.intentConfidence * 100)}% (rule-based)</span>
        {r.escalation.required
          ? <span className="badge danger">Escalated to human{r.escalation.priority === "high" ? " · high priority" : ""}</span>
          : <span className="badge sage">Auto-answer permitted (draft only)</span>}
        <span className="badge plain">Not sent</span>
      </div>
      {r.escalation.required && <p style={{ margin: 0, fontSize: 13 }}><b style={{ fontWeight: 500 }}>Why:</b> {r.escalation.reason}</p>}

      <div>
        <div className="eyebrow">Draft response (simulated, not sent)</div>
        <div className="bubble out" style={{ maxWidth: "100%", whiteSpace: "pre-wrap" }}>{r.draftResponse}</div>
      </div>

      <div>
        <div className="eyebrow">Recommended products (sample catalogue)</div>
        {r.recommendations.length ? (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {r.recommendations.map((p) => (
              <li key={p.productId} style={{ marginBottom: 6 }}>
                <b style={{ fontWeight: 500 }}>{p.name}</b> <span className="muted">· {p.productId} · match {p.matchScore}</span>
                <div className="muted">{p.priceLabel}</div>
                <div>{p.matchReasons.join(" · ")}</div>
              </li>
            ))}
          </ul>
        ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>No products recommended for this enquiry.</p>}
      </div>

      <div>
        <div className="eyebrow">Suggested next action</div>
        <p style={{ margin: 0, fontSize: 13 }}>{r.suggestedNextAction.label} <span className="badge plain">{r.suggestedNextAction.owner === "human" ? "Human" : "Agent"}</span></p>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>{r.dataSource.note}</p>
    </div>
  );
}
