/** Places client failures. Messages are FIXED text per kind: Google's own error text is never copied into them, because a response can
 *  contain business content (class G) and error messages end up in logs and rows. The optional `code` is an upper-case status token
 *  (for example RESOURCE_EXHAUSTED) that passed a strict pattern. */

export type PlacesErrorKind =
  | "disabled" | "demo" | "stopped" | "budget"
  | "bad_request" | "unauthorized" | "forbidden" | "not_found"
  | "throttled" | "server" | "network" | "timeout" | "invalid_response";

const MESSAGES: Record<PlacesErrorKind, string> = {
  disabled: "Google Places is switched off in this environment.",
  demo: "Demonstration organisations never call Google Places.",
  stopped: "Prospecting has been stopped.",
  budget: "The spending cap for this campaign or organisation has been reached.",
  bad_request: "Google Places rejected the request.",
  unauthorized: "Google Places did not accept the credentials.",
  forbidden: "Google Places refused access for this request.",
  not_found: "Google Places has no record of that place.",
  throttled: "Google Places is rate limiting requests; try again later.",
  server: "Google Places reported a server problem.",
  network: "Could not reach Google Places.",
  timeout: "Google Places did not answer in time.",
  invalid_response: "Google Places returned an answer in an unexpected shape.",
};

export class PlacesError extends Error {
  constructor(readonly kind: PlacesErrorKind, readonly operation: string, readonly status?: number, readonly code?: string, readonly retryAfterMs?: number) {
    super(MESSAGES[kind]);
    this.name = "PlacesError";
  }
}

/** Accepts only a short upper-case token, so no free text can slip through as a "code". */
export function safeStatusCode(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[A-Z][A-Z_]{2,39}$/.test(raw) ? raw : undefined;
}

export function kindForStatus(status: number): PlacesErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return "bad_request";
}

/** What a person should be told. Never contains a secret or Google content. */
export function describePlacesProblem(e: unknown): string {
  if (e instanceof PlacesError) return e.retryAfterMs ? `${e.message} Try again in about ${Math.max(1, Math.ceil(e.retryAfterMs / 1000))} seconds.` : e.message;
  return "Google Places lookup failed.";
}
