/** A scripted fake for the OpenAI transport and an in-memory usage ledger. NO test using these touches the network. */
import type { AiLedger, LedgerRow } from "@/lib/ai/limits";
import type { OpenAiRawResponse, OpenAiRequest, OpenAiTransport } from "@/lib/ai/transport";

export interface FakeTransport { transport: OpenAiTransport; calls: OpenAiRequest[] }

type Step = OpenAiRawResponse | Error | ((req: OpenAiRequest) => OpenAiRawResponse | Promise<OpenAiRawResponse>);

/** Plays the steps in order (the last step repeats). */
export function fakeTransport(...steps: Step[]): FakeTransport {
  const calls: OpenAiRequest[] = [];
  const transport: OpenAiTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(req) : step;
  };
  return { transport, calls };
}

/** A well-formed Responses API body whose output text is the given object. */
export const okBody = (payload: unknown, usage = { input_tokens: 400, output_tokens: 300 }): OpenAiRawResponse => ({
  status: 200,
  body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage },
});

export const GOOD_OUTPUT = {
  caption: "A quiet little ring for your everyday look.\n\nSimple lines, easy to wear, easy to love.",
  reel_on_screen: ["Small details", "Everyday ring", "Made to be worn"],
  story_text: ["Meet the ring", "Simple and minimal"],
  canva_headline: "The everyday ring",
};

export class MemoryLedger implements AiLedger {
  rows: (LedgerRow & { agent: string })[] = [];
  failReads = false;
  failWrites = false;
  async usage(since: string): Promise<LedgerRow[]> {
    if (this.failReads) throw new Error("read failed");
    return this.rows.filter((r) => r.at >= since).map(({ action, at }) => ({ action, at }));
  }
  async record(action: string, agent: string): Promise<void> {
    if (this.failWrites) throw new Error("write failed");
    this.rows.push({ action, agent, at: new Date().toISOString() });
  }
}
