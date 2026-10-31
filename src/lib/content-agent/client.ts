import type { Audience, ContentDraft } from "@/types/content-agent";
import { checkMarketplaceLink } from "./links";

export interface ContentFormValues {
  /** "product:<id>" or "pack:<id>" */
  target: string;
  audience: Audience;
  amazonUrl: string;
  flipkartUrl: string;
}

export type ContentPanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; draft: ContentDraft; note?: string; values: ContentFormValues };

export function validateForm(v: ContentFormValues): string | null {
  if (!/^(product|pack):.+/.test(v.target)) return "Choose a product or a combo pack.";
  for (const [market, url] of [["amazon", v.amazonUrl], ["flipkart", v.flipkartUrl]] as const) {
    if (!url.trim()) continue;
    const res = checkMarketplaceLink(market, url);
    if (!res.ok) return res.reason;
  }
  return null;
}

const body = (v: ContentFormValues) => {
  const [targetType, ...rest] = v.target.split(":");
  return JSON.stringify({
    targetType, targetId: rest.join(":"), audience: v.audience,
    amazonUrl: v.amazonUrl.trim() || undefined, flipkartUrl: v.flipkartUrl.trim() || undefined,
  });
};

const post = (path: string, v: ContentFormValues, fetchImpl: typeof fetch) =>
  fetchImpl(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(v) });

/** Never throws: failures come back as an "error" state. */
export async function requestDraft(v: ContentFormValues, fetchImpl: typeof fetch = fetch): Promise<ContentPanelState> {
  const invalid = validateForm(v);
  if (invalid) return { status: "invalid", message: invalid };
  try {
    const res = await post("/api/agents/content/run", v, fetchImpl);
    if (!res.ok) return { status: "error", message: "The agent couldn't create a draft. Please try again." };
    const data = (await res.json()) as { draft: ContentDraft; note?: string };
    return { status: "done", draft: data.draft, note: data.note, values: v };
  } catch {
    return { status: "error", message: "Couldn't reach the agent. Check your connection and try again." };
  }
}

export type SubmitOutcome = { ok: true } | { ok: false; message: string };

/** Queues the draft for human review. Never throws. */
export async function submitDraft(v: ContentFormValues, fetchImpl: typeof fetch = fetch): Promise<SubmitOutcome> {
  try {
    const res = await post("/api/agents/content/submit", v, fetchImpl);
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: false, message: "An identical draft is already waiting in Approvals." };
    if (res.status === 422) return { ok: false, message: "This draft has blocking issues and can't be submitted." };
    return { ok: false, message: "Couldn't send the draft for review. Please try again." };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
}
