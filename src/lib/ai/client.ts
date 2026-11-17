/** Shared, provider-agnostic-by-seam client for the OpenAI Responses API with STRUCTURED output.
 *  - One attempt per call, no retries: every attempt is reserved against the spend and call caps first (limits.ts), and a retry would
 *    spend again. A failure returns a code and the caller falls back to its template.
 *  - The model gets no tools and no data access: only instructions and one input string.
 *  - `store: false` asks the provider not to retain the request.
 *  - The request shape follows the documented Responses API. IT HAS NOT BEEN VERIFIED WITH A LIVE CALL (none is authorised yet). */
import type { AiConfig } from "./config";
import type { OpenAiTransport } from "./transport";

export type AiErrorCode = "timeout" | "network" | "http_error" | "refused" | "incomplete" | "bad_output" | "invalid_output";

export interface AiUsage { inputTokens: number; outputTokens: number }

export type AiResult<T> =
  | { ok: true; data: T; usage: AiUsage; model: string }
  | { ok: false; code: AiErrorCode; status?: number };

export interface StructuredRequest<T> {
  transport: OpenAiTransport;
  config: AiConfig;
  instructions: string;
  /** The single user input, already redacted. */
  input: string;
  schemaName: string;
  /** JSON Schema for strict structured output. */
  schema: Record<string, unknown>;
  /** Returns the typed value, or null when the model's JSON does not meet the contract. */
  validate: (raw: unknown) => T | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Pulls the model's text (or a refusal) out of a Responses API body. */
function readOutput(body: unknown): { text: string } | { refused: true } | { incomplete: true } | null {
  if (!isObject(body)) return null;
  if (body.status === "incomplete") return { incomplete: true };
  const output = Array.isArray(body.output) ? body.output : [];
  let text = "";
  for (const item of output) {
    if (!isObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObject(part)) continue;
      if (part.type === "refusal") return { refused: true };
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text ? { text } : null;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

export async function callStructured<T>(req: StructuredRequest<T>): Promise<AiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.config.timeoutMs);
  let status: number;
  let body: unknown;
  try {
    const res = await req.transport({
      path: "/v1/responses",
      signal: controller.signal,
      body: {
        model: req.config.model,
        instructions: req.instructions,
        input: req.input,
        max_output_tokens: req.config.maxOutputTokens,
        store: false,
        text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
      },
    });
    status = res.status;
    body = res.body;
  } catch (e) {
    return { ok: false, code: controller.signal.aborted || (e instanceof Error && e.name === "AbortError") ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
  if (status < 200 || status >= 300) return { ok: false, code: "http_error", status };

  const out = readOutput(body);
  if (!out) return { ok: false, code: "bad_output" };
  if ("refused" in out) return { ok: false, code: "refused" };
  if ("incomplete" in out) return { ok: false, code: "incomplete" };
  let raw: unknown;
  try { raw = JSON.parse(out.text); } catch { return { ok: false, code: "bad_output" }; }
  const data = req.validate(raw);
  if (data === null) return { ok: false, code: "invalid_output" };

  const usage = isObject(body) && isObject(body.usage) ? body.usage : {};
  return { ok: true, data, model: req.config.model, usage: { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) } };
}

/** Plain-language reason shown to the user. Never includes provider text, status bodies or keys. */
export function describeAiError(code: AiErrorCode): string {
  switch (code) {
    case "timeout": return "the AI took too long";
    case "network": return "the AI service could not be reached";
    case "http_error": return "the AI service returned an error";
    case "refused": return "the AI declined the request";
    case "incomplete": return "the AI response was cut off";
    default: return "the AI response could not be used";
  }
}
