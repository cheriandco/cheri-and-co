/** Login with Amazon (LWA): exchanges the seller's refresh token for a short-lived access token, caches it, refreshes it before it expires.
 *  Secrets are read only from the credentials passed in; they are never logged and never placed in an error message. */
import type { AmazonCredentials } from "./config";
import { LWA_TOKEN_URL } from "./config";
import { safeMessage } from "./redact";

export class LwaError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "LwaError";
  }
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Forget the cached token (used after Amazon answers 401 once). */
  invalidate(): void;
}

export interface LwaOptions {
  credentials: AmazonCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Refresh this many ms before the stated expiry. */
  skewMs?: number;
}

export function createLwaTokenProvider(opts: LwaOptions): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const skewMs = opts.skewMs ?? 60_000;
  const { clientId, clientSecret, refreshToken } = opts.credentials;
  const secrets = [clientId, clientSecret, refreshToken];

  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
    let res: Response;
    try {
      res = await fetchImpl(LWA_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    } catch {
      throw new LwaError("Could not reach Amazon sign-in (LWA).");
    }
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
    if (!res.ok) {
      const code = typeof json.error === "string" ? safeMessage(json.error, secrets, 60) : undefined;
      throw new LwaError(`Amazon sign-in (LWA) was refused${code ? `: ${code}` : ""}. Check the client id, secret and refresh token.`, res.status, code);
    }
    const token = json.access_token;
    const ttl = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    if (typeof token !== "string" || !token) throw new LwaError("Amazon sign-in (LWA) returned no access token.", res.status);
    cached = { token, expiresAt: now() + ttl * 1000 - skewMs };
    return token;
  }

  return {
    async getAccessToken() {
      if (cached && now() < cached.expiresAt) return cached.token;
      if (!inflight) inflight = fetchToken().finally(() => { inflight = null; }); // concurrent callers share one exchange
      return inflight;
    },
    invalidate() { cached = null; },
  };
}
