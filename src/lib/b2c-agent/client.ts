import type { B2CAgentResult } from "@/types/b2c-agent";

export const MAX_ENQUIRY_LENGTH = 1000;

export type PanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; result: B2CAgentResult };

export function validateEnquiry(text: string): string | null {
  const t = text.trim();
  if (!t) return "Enter a customer enquiry to run the agent.";
  if (t.length > MAX_ENQUIRY_LENGTH) return `Keep the enquiry under ${MAX_ENQUIRY_LENGTH} characters.`;
  return null;
}

/** Calls the prototype route. Never throws: failures come back as an "error" state. */
export async function requestAgent(text: string, fetchImpl: typeof fetch = fetch): Promise<PanelState> {
  const invalid = validateEnquiry(text);
  if (invalid) return { status: "invalid", message: invalid };
  try {
    const res = await fetchImpl("/api/agents/b2c/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enquiry: text.trim() }),
    });
    if (!res.ok) return { status: "error", message: "The agent couldn't process that enquiry. Please try again." };
    return { status: "done", result: (await res.json()) as B2CAgentResult };
  } catch {
    return { status: "error", message: "Couldn't reach the agent. Check your connection and try again." };
  }
}
