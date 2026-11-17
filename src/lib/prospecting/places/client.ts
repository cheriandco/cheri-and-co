/** Typed Places client over an injected transport (no network code, no credentials, no dependencies).
 *
 *  Order of refusals before ANY attempt reaches the transport (specification section 8.2 of the Phase 0 plan):
 *    1. demonstration organisation  2. kill switch off (default)  3. stop-all active  4. local rate limit  5. budget reservation.
 *  Then: a timeout per attempt; retries with exponential backoff for network errors, timeouts and 5xx; 429 honours Retry-After when it is
 *  short, otherwise surfaces `throttled` with the wait so the caller can save its place and resume; other 4xx never retry.
 *  Every attempt that passes the reservation is counted, even if it fails. Errors carry fixed text only (never Google content), and the
 *  client never logs. Results are `GoogleTransient` values (class G): this module cannot write permanent data. */
import { mapDetailsResponse, mapSearchResponse, isValidPlaceId } from "./mappers";
import { DEFAULT_MAX_PAGES, DEFAULT_MAX_RETRIES, DEFAULT_MAX_WAIT_MS, DEFAULT_RATE_LIMIT, DEFAULT_TIMEOUT_MS, MAX_PAGE_SIZE, type RateLimit } from "./config";
import { PlacesError, kindForStatus, safeStatusCode } from "./errors";
import { buildFieldMask, type FieldMask } from "./field-masks";
import { estimateCostUsd, NoopUsageSink, type BudgetGate, type UsageEvent, type UsageOutcome, type UsageSink } from "./budget";
import { TokenBucket } from "./rate-limit";
import { SEARCH_PATH, detailsPath, type PlacesOperation, type PlacesRawResponse, type PlacesTransport, type SearchQuery } from "./transport";
import type { GoogleTransient } from "../transient";

export interface PlacesClientOptions {
  transport: PlacesTransport;
  budget: BudgetGate;
  /** The environment kill switch (`GOOGLE_PLACES_ENABLED`). Must be explicitly true. */
  enabled: boolean;
  /** True for demonstration organisations: no Google call is ever made for them. */
  demo?: boolean;
  /** Organisation-wide "stop all prospecting". Checked before every attempt. */
  isStopped?: () => boolean | Promise<boolean>;
  usage?: UsageSink;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest the client sleeps (rate limit, backoff, Retry-After) before giving up with `throttled`. */
  maxWaitMs?: number;
  rate?: RateLimit;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface SearchPage { places: GoogleTransient[]; nextPageToken?: string; dropped: number }

export interface SearchAllResult {
  places: GoogleTransient[];
  pages: number;
  /** Entries without a usable Place ID. */
  dropped: number;
  /** The same Place ID seen again on a later page of this run. */
  repeated: number;
  /** Present when more pages exist (page cap reached) or a later page failed: a place to resume from. */
  nextPageToken?: string;
  /** Present when a page after the first failed. The places already collected are still returned. */
  stoppedBy?: PlacesError;
}

class AttemptTimeout extends Error { constructor() { super("attempt timeout"); } }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class PlacesClient {
  private readonly o: Required<Pick<PlacesClientOptions, "timeoutMs" | "maxRetries" | "maxWaitMs" | "rate">> & PlacesClientOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly usage: UsageSink;
  private readonly bucket: TokenBucket;

  constructor(opts: PlacesClientOptions) {
    this.o = { ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES, maxWaitMs: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, rate: opts.rate ?? DEFAULT_RATE_LIMIT };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.usage = opts.usage ?? new NoopUsageSink();
    this.bucket = new TokenBucket(this.o.rate, this.now);
  }

  /** One Text Search page. Needs a `pageToken` from the previous page to continue (the same `textQuery` must be sent again). */
  async searchPage(query: SearchQuery, opts: { fields?: readonly string[] } = {}): Promise<SearchPage> {
    const textQuery = query.textQuery.trim();
    if (!textQuery || textQuery.length > 300) throw new PlacesError("bad_request", "searchText");
    if (query.pageToken !== undefined && (!query.pageToken || query.pageToken.length > 4096)) throw new PlacesError("bad_request", "searchText");
    const region = query.regionCode ?? "IN";
    if (!/^[A-Z]{2}$/.test(region)) throw new PlacesError("bad_request", "searchText");
    const body: Record<string, unknown> = { textQuery, pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? MAX_PAGE_SIZE))), regionCode: region };
    if (query.languageCode) body.languageCode = query.languageCode;
    if (query.pageToken) body.pageToken = query.pageToken;
    const mask = buildFieldMask("search", opts.fields);
    return this.call("searchText", { method: "POST", path: SEARCH_PATH, body }, mask, (b, at) => mapSearchResponse(b, at));
  }

  /** Follows page tokens up to `maxPages`. Places already collected survive a later-page failure (returned with `stoppedBy`). */
  async searchAll(query: SearchQuery, opts: { maxPages?: number; fields?: readonly string[]; betweenPagesMs?: number } = {}): Promise<SearchAllResult> {
    const maxPages = Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES));
    const seen = new Set<string>();
    const result: SearchAllResult = { places: [], pages: 0, dropped: 0, repeated: 0 };
    let token = query.pageToken;
    while (result.pages < maxPages) {
      let page: SearchPage;
      try { page = await this.searchPage({ ...query, pageToken: token }, { fields: opts.fields }); }
      catch (e) {
        if (result.pages === 0 || !(e instanceof PlacesError)) throw e;
        result.stoppedBy = e; result.nextPageToken = token;
        return result;
      }
      result.pages += 1;
      result.dropped += page.dropped;
      for (const p of page.places) { if (seen.has(p.placeId)) result.repeated += 1; else { seen.add(p.placeId); result.places.push(p); } }
      token = page.nextPageToken;
      if (!token) { result.nextPageToken = undefined; return result; }
      result.nextPageToken = token;
      if (result.pages < maxPages && opts.betweenPagesMs) await this.sleep(opts.betweenPagesMs);
    }
    return result;
  }

  /** Place Details for one Place ID. `not_found` means the ID is stale or unknown to Google. */
  async details(placeId: string, opts: { fields?: readonly string[] } = {}): Promise<GoogleTransient> {
    if (!isValidPlaceId(placeId)) throw new PlacesError("bad_request", "placeDetails");
    const mask = buildFieldMask("details", opts.fields);
    const place = await this.call("placeDetails", { method: "GET", path: detailsPath(placeId) }, mask, (b, at) => {
      const m = mapDetailsResponse(b, at);
      return m && m.placeId === placeId ? m : undefined;
    });
    return place;
  }

  // ---- internals ----

  private async guards(op: PlacesOperation): Promise<void> {
    if (this.o.demo) throw new PlacesError("demo", op);
    if (this.o.enabled !== true) throw new PlacesError("disabled", op);
    if (this.o.isStopped && (await this.o.isStopped())) throw new PlacesError("stopped", op);
  }

  private backoff(attempt: number): number {
    return Math.min(this.o.maxWaitMs, 500 * 2 ** attempt + Math.floor(this.random() * 250));
  }

  private async record(op: PlacesOperation, outcome: UsageOutcome, attempt: number, started: number, status?: number): Promise<void> {
    const event: UsageEvent = { operation: op, outcome, status, attempt, durationMs: Math.max(0, this.now() - started), at: new Date(this.now()).toISOString() };
    try { await this.usage.record(event); } catch { /* a failing usage sink must never break a lookup or leak anything */ }
  }

  private async sendOnce(req: { operation: PlacesOperation; method: "GET" | "POST"; path: string; fieldMask: string; body?: Record<string, unknown> }): Promise<PlacesRawResponse> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new AttemptTimeout()); }, this.o.timeoutMs); });
    try { return await Promise.race([this.o.transport.send({ ...req, signal: ac.signal }), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async call<T>(op: PlacesOperation, req: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> }, mask: FieldMask, parse: (body: unknown, fetchedAt: string) => T | undefined): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.guards(op);

      const wait = this.bucket.waitMs();
      if (wait > this.o.maxWaitMs) throw new PlacesError("throttled", op, undefined, undefined, wait);
      if (wait > 0) await this.sleep(wait);
      this.bucket.take();

      const decision = await this.o.budget.reserve({ operation: op, tier: mask.tier, estimatedCostUsd: estimateCostUsd(op) });
      if (!decision.ok) throw new PlacesError(decision.reason === "stopped" ? "stopped" : "budget", op);

      const started = this.now();
      let res: PlacesRawResponse;
      try {
        res = await this.sendOnce({ operation: op, method: req.method, path: req.path, fieldMask: mask.header, body: req.body });
      } catch (e) {
        const timedOut = e instanceof AttemptTimeout;
        await this.record(op, timedOut ? "timeout" : "network", attempt, started);
        if (attempt < this.o.maxRetries) { await this.sleep(this.backoff(attempt)); continue; }
        throw new PlacesError(timedOut ? "timeout" : "network", op);
      }

      if (res.status >= 200 && res.status < 300) {
        const parsed = parse(res.body, new Date(this.now()).toISOString());
        if (parsed === undefined) { await this.record(op, "invalid_response", attempt, started, res.status); throw new PlacesError("invalid_response", op, res.status); }
        await this.record(op, "ok", attempt, started, res.status);
        return parsed;
      }

      const code = safeStatusCode(isRecord(res.body) && isRecord(res.body.error) ? res.body.error.status : undefined);
      if (res.status === 429) {
        const header = Number(res.headers["retry-after"]);
        const retryMs = Number.isFinite(header) && header > 0 ? Math.ceil(header * 1000) : Math.ceil(1000 / this.o.rate.rate);
        await this.record(op, "throttled", attempt, started, 429);
        if (retryMs <= this.o.maxWaitMs && attempt < this.o.maxRetries) { await this.sleep(retryMs); continue; }
        throw new PlacesError("throttled", op, 429, code, retryMs);
      }
      await this.record(op, "http_error", attempt, started, res.status);
      if (res.status >= 500 && attempt < this.o.maxRetries) { await this.sleep(this.backoff(attempt)); continue; }
      throw new PlacesError(kindForStatus(res.status), op, res.status, code);
    }
  }
}
