/** The seam between the AI client and the network, and the ONLY module that knows the provider's host name or reads the API key.
 *  Everything else receives a transport function, so tests inject a fake and no test ever touches the network.
 *  Server-only by use: nothing here is imported by a client component. The key is never logged, returned or put in an error. */

export const OPENAI_BASE = "https://api.openai.com";

export interface OpenAiRequest {
  path: "/v1/responses";
  body: Record<string, unknown>;
  /** Aborted when the client's timeout fires. */
  signal: AbortSignal;
}

export interface OpenAiRawResponse { status: number; body: unknown }

export type OpenAiTransport = (req: OpenAiRequest) => Promise<OpenAiRawResponse>;

/** Real transport. Reads no environment; the caller supplies the key. Never throws a message containing the key. */
export function createOpenAiTransport(apiKey: string, fetchImpl: typeof fetch = fetch): OpenAiTransport {
  return async (req) => {
    const url = `${OPENAI_BASE}${req.path}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(req.body),
      signal: req.signal,
      cache: "no-store",
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON error page: leave null */ }
    return { status: res.status, body };
  };
}

/** The only place OPENAI_API_KEY is read. Null when it is missing or blank, so the caller falls back to templates. */
export function getOpenAiTransport(env: Record<string, string | undefined> = process.env): OpenAiTransport | null {
  const key = env.OPENAI_API_KEY?.trim();
  return key ? createOpenAiTransport(key) : null;
}
