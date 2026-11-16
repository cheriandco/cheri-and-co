/** Typed, throttled SP-API HTTP client (native fetch, no dependencies).
 *
 *  - Sends only the LWA access token (`x-amz-access-token`) and only to the two allow-listed Amazon hosts.
 *  - Throttles each operation with a token bucket at Amazon's documented default rate and burst. Documented limits can be very low (the
 *    orders operation allows about one request every three minutes once its burst is spent), and a serverless request cannot wait that
 *    long, so when the wait would exceed `maxWaitMs` the client throws `ThrottledError` instead of sleeping. Callers save their place and resume later.
 *  - Retries 5xx and network failures with exponential backoff and jitter; refreshes the token once after a 401; never retries 400/403/404.
 *  - Never logs. Error messages are redacted and truncated. */
import { assertAllowedBaseUrl, type AmazonPublicConfig } from "./config";
import type { TokenProvider } from "./lwa";
import { LwaError } from "./lwa";
import { safeMessage } from "./redact";

export interface OperationLimit { /** requests per second */ rate: number; burst: number }

/** Amazon's documented default usage plans (from the published API models, read 2026-11-11). Higher limits may apply to an account. */
export const LIMITS = {
  getMarketplaceParticipations: { rate: 0.016, burst: 15 },
  searchOrders: { rate: 0.0056, burst: 20 },
  searchListingsItems: { rate: 5, burst: 5 },
  searchCatalogItems: { rate: 2, burst: 2 },
  getInventorySummaries: { rate: 2, burst: 2 },
  createReport: { rate: 0.0167, burst: 15 },
  getReport: { rate: 2, burst: 15 },
  getReportDocument: { rate: 0.0167, burst: 15 },
} as const satisfies Record<string, OperationLimit>;

export type OperationName = keyof typeof LIMITS;

export type SpApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "bad_request" | "server" | "network";

export class SpApiError extends Error {
  constructor(readonly kind: SpApiErrorKind, message: string, readonly operation: string, readonly status?: number, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "SpApiError";
  }
}

/** Amazon's rate limit (or ours) says: not now. Not a failure: save progress and come back after `retryAfterMs`. */
export class ThrottledError extends Error {
  constructor(readonly operation: string, readonly retryAfterMs: number) {
    super(`Amazon rate limit reached for ${operation}; try again in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds.`);
    this.name = "ThrottledError";
  }
}

class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly limit: OperationLimit, private readonly now: () => number) { this.tokens = limit.burst; this.last = now(); }
  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.limit.burst, this.tokens + ((t - this.last) / 1000) * this.limit.rate);
    this.last = t;
  }
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.limit.rate) * 1000);
  }
  take() { this.refill(); this.tokens -= 1; }
}

export type Query = Record<string, string | number | boolean | readonly string[] | undefined | null>;

export interface RequestOptions { method?: "GET" | "POST"; path: string; query?: Query; body?: unknown }
export interface ApiResponse { data: unknown; headers: Headers }

export interface SpApiClientOptions {
  config: AmazonPublicConfig;
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Longest this client will sleep for throttling or backoff before giving up with ThrottledError. */
  maxWaitMs?: number;
  maxRetries?: number;
  /** Extra values to scrub from error text (the credentials themselves are never given to this class). */
  secrets?: readonly string[];
}

const USER_AGENT = "Cheri-and-Co-Intelligence/1.0 (Language=TypeScript)";

export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, Array.isArray(v) ? (v as readonly string[]).join(",") : String(v));
  }
  const qs = params.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
}

export class SpApiClient {
  readonly config: AmazonPublicConfig;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private readonly secrets: readonly string[];
  private readonly buckets = new Map<OperationName, TokenBucket>();

  constructor(opts: SpApiClientOptions) {
    assertAllowedBaseUrl(opts.config.baseUrl);
    this.config = opts.config;
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.maxWaitMs = opts.maxWaitMs ?? 2_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.secrets = opts.secrets ?? [];
  }

  /** A plain GET with no Amazon credentials attached; used only for presigned report downloads (see `downloadPresigned`). */
  rawFetch(url: string): Promise<Response> {
    return this.fetchImpl(url, { method: "GET", headers: { "user-agent": USER_AGENT } });
  }

  private bucket(op: OperationName): TokenBucket {
    let b = this.buckets.get(op);
    if (!b) { b = new TokenBucket(LIMITS[op], this.now); this.buckets.set(op, b); }
    return b;
  }

  private backoff(attempt: number): number {
    return Math.min(this.maxWaitMs, 500 * 2 ** attempt + Math.floor(this.random() * 250));
  }

  async request(op: OperationName, opts: RequestOptions): Promise<ApiResponse> {
    const url = buildUrl(this.config.baseUrl, opts.path, opts.query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.bucket(op).waitMs();
      if (wait > this.maxWaitMs) throw new ThrottledError(op, wait);
      if (wait > 0) await this.sleep(wait);
      this.bucket(op).take();

      let res: Response;
      try {
        const token = await this.tokens.getAccessToken();
        res = await this.fetchImpl(url, {
          method: opts.method ?? "GET",
          headers: { "x-amz-access-token": token, "user-agent": USER_AGENT, accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        if (e instanceof LwaError) throw e;
        if (attempt < this.maxRetries) { await this.sleep(this.backoff(attempt)); continue; }
        throw new SpApiError("network", "Could not reach Amazon.", op);
      }

      const requestId = res.headers.get("x-amzn-requestid") ?? undefined;
      if (res.ok) return { data: await readJson(res), headers: res.headers };

      const text = await res.text().catch(() => "");
      const { code, message } = readError(text, this.secrets);
      if (res.status === 401 && !refreshed) { refreshed = true; this.tokens.invalidate(); continue; }
      if (res.status === 429) {
        const header = Number(res.headers.get("retry-after"));
        const retryMs = Number.isFinite(header) && header > 0 ? header * 1000 : Math.ceil(1000 / LIMITS[op].rate);
        if (retryMs <= this.maxWaitMs && attempt < this.maxRetries) { await this.sleep(retryMs); continue; }
        throw new ThrottledError(op, retryMs);
      }
      if (res.status >= 500 && attempt < this.maxRetries) { await this.sleep(this.backoff(attempt)); continue; }
      throw new SpApiError(kindFor(res.status), message || `Amazon answered ${res.status} for ${op}.`, op, res.status, code, requestId);
    }
  }
}

/** Downloads a report document from the presigned URL Amazon returned. Sent WITHOUT the Amazon token (the URL is its own credential),
 *  https only, Amazon storage hosts only, size-capped. The URL is never logged or put in an error. */
export async function downloadPresigned(client: SpApiClient, url: string, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array> {
  let host = "";
  try { const u = new URL(url); if (u.protocol === "https:") host = u.hostname.toLowerCase(); } catch { /* invalid */ }
  if (!host || !(host === "amazonaws.com" || host.endsWith(".amazonaws.com"))) throw new SpApiError("bad_request", "Amazon returned a report address that is not an Amazon storage host; refusing to download.", "getReportDocument");
  let res: Response;
  try { res = await client.rawFetch(url); } catch { throw new SpApiError("network", "Could not download the report from Amazon.", "getReportDocument"); }
  if (!res.ok) throw new SpApiError(res.status >= 500 ? "server" : "bad_request", `Amazon storage answered ${res.status} for the report download.`, "getReportDocument", res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new SpApiError("bad_request", "The report is larger than the allowed size.", "getReportDocument");
  return buf;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function readError(text: string, secrets: readonly string[]): { code?: string; message: string } {
  try {
    const json = JSON.parse(text) as { errors?: { code?: unknown; message?: unknown }[] };
    const first = json.errors?.[0];
    const code = typeof first?.code === "string" ? safeMessage(first.code, secrets, 60) : undefined;
    return { code, message: safeMessage(first?.message, secrets) };
  } catch {
    return { message: safeMessage(text, secrets, 160) };
  }
}

function kindFor(status: number): SpApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "bad_request";
}

/** What a person should be told about a failure. Never contains a secret. */
export function describeApiProblem(e: unknown): string {
  if (e instanceof ThrottledError) return e.message;
  if (e instanceof LwaError) return e.message;
  if (e instanceof SpApiError) {
    if (e.kind === "forbidden") return `Amazon refused ${e.operation} (403). Check the private app's roles; the API role for this operation may be missing.`;
    if (e.kind === "unauthorized") return "Amazon rejected the access token (401). The refresh token may have been revoked; authorize the app again.";
    if (e.kind === "not_found") return `Amazon could not find what ${e.operation} asked for (404).`;
    if (e.kind === "network") return "Could not reach Amazon.";
    return `Amazon reported a problem with ${e.operation}${e.status ? ` (${e.status})` : ""}${e.code ? `: ${e.code}` : ""}.`;
  }
  return "Amazon sync failed.";
}
