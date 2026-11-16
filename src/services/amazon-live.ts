/** Amazon Intelligence for live organisations. Everything runs as the signed-in user's own Supabase session (RLS applies; no service-role key), is scoped to
 *  the organisation from the verified session and to ONE Amazon environment taken from server configuration (never from a request), and is read-only toward
 *  Amazon. Approving an Amazon insight records a human decision in the existing approvals table and nothing else: no call to Amazon is ever made from it. */
import { AuthError, requireAccess } from "@/lib/auth/access";
import { getAuthUser } from "@/lib/auth/session";
import { can as roleCan } from "@/lib/auth/roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { findProhibitedClaims } from "@/lib/content-agent/claims";
import { SpApiClient } from "@/lib/amazon/client";
import { amazonConfigStatus, describeConfigProblem, type AmazonConfig } from "@/lib/amazon/config";
import { createLwaTokenProvider, type TokenProvider } from "@/lib/amazon/lwa";
import type { AmazonRepo, InsightRow, SyncKind } from "@/lib/amazon/repo";
import { SupabaseAmazonRepo, isMissingTable, AmazonStoreError } from "@/lib/amazon/supabase-repo";
import { generateInsights, type Evidence } from "@/lib/amazon/insights/rules";
import { SYNC_KINDS, syncStep, verifyConnection, type VerifyResult } from "@/lib/amazon/sync/run";
import type { StepResult } from "@/lib/amazon/sync/types";
import { AmazonConfigError, type AmazonLiveView, type AmazonOverview } from "@/lib/amazon/view";
import { liveLog } from "./live";
import { toApproval, type ApprovalRow } from "./live-map";
import type { Approval } from "@/types";


const DAY = 86_400_000;
let tokenCache: { key: string; provider: TokenProvider } | null = null;

function tokensFor(cfg: AmazonConfig): TokenProvider {
  const c = cfg.credentials();
  const key = `${cfg.environment}:${c.clientId}`;
  if (!tokenCache || tokenCache.key !== key) tokenCache = { key, provider: createLwaTokenProvider({ credentials: c }) };
  return tokenCache.provider;
}

async function base() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();
  if (!user?.orgId || !supabase) throw new AuthError(401, "Authentication required");
  return { user, supabase, orgId: user.orgId };
}

/** The Amazon environment and credentials come from server configuration only. */
function configOrThrow(): AmazonConfig {
  const status = amazonConfigStatus();
  if (!status.ok) throw new AmazonConfigError(describeConfigProblem(status));
  return status.config;
}

async function repoFor(cfg: AmazonConfig): Promise<{ repo: AmazonRepo; supabase: Awaited<ReturnType<typeof base>>["supabase"]; orgId: string; role: string | null }> {
  const { user, supabase, orgId } = await base();
  return { repo: new SupabaseAmazonRepo(supabase, orgId, cfg.environment, cfg.marketplaceId), supabase, orgId, role: user.role };
}

function syncDeps(cfg: AmazonConfig, repo: AmazonRepo) {
  const c = cfg.credentials();
  const client = new SpApiClient({ config: cfg, tokens: tokensFor(cfg), secrets: [c.clientId, c.clientSecret, c.refreshToken] });
  return { client, repo, sellerId: cfg.sellerId, now: () => new Date() };
}

/* ---------- dashboard ---------- */

export async function getAmazonLive(): Promise<AmazonLiveView> {
  const status = amazonConfigStatus();
  if (!status.ok) return { state: "unconfigured", message: describeConfigProblem(status) };
  const cfg = status.config;
  const { repo, role } = await repoFor(cfg);
  try {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const [connection, runs, lines, orders, products, inventory, reports, insights] = await Promise.all([
      repo.getConnection(), repo.recentRuns(8), repo.salesLines(since), repo.orders(200), repo.products(), repo.inventory(), repo.reports(10), repo.insights(),
    ]);
    const bySku = new Map<string, { title: string | null; units: number }>();
    let value = 0, priced = false, currency: string | null = null;
    for (const l of lines) {
      const k = l.sellerSku ?? l.asin;
      if (k) { const cur = bySku.get(k) ?? { title: l.title, units: 0 }; cur.units += l.quantity; bySku.set(k, cur); }
      if (l.unitPrice !== null) { value += l.unitPrice * l.quantity; priced = true; }
    }
    currency = orders.find((o) => o.currencyCode)?.currencyCode ?? products.find((p) => p.currencyCode)?.currencyCode ?? null;
    const fba = inventory.filter((i) => i.source === "fba");
    const overview: AmazonOverview = {
      days: 30, unitsOrdered: [...bySku.values()].reduce((s, v) => s + v.units, 0), orderedValue: priced ? Math.round(value * 100) / 100 : null, currencyCode: currency,
      orderCount: orders.filter((o) => o.createdTime >= since).length, orderCountCapped: orders.length >= 200,
      listings: products.length, listingsWithErrors: products.filter((p) => p.issueErrorCount > 0).length,
      fbaFulfillableUnits: fba.length ? fba.reduce((s, i) => s + (i.fulfillable ?? 0), 0) : null,
      topSkus: [...bySku.entries()].sort((a, b) => b[1].units - a[1].units).slice(0, 5).map(([sku, v]) => ({ sku, title: v.title, units: v.units })),
    };
    return {
      state: "ready", environment: cfg.environment, simulated: cfg.environment === "sandbox", marketplaceId: cfg.marketplaceId, connection, canSync: roleCan(role as never, "amazon:sync"), canQueue: roleCan(role as never, "agents:run"),
      runs, overview, orders: orders.slice(0, 25), products, inventory, reports, insights,
    };
  } catch (e) {
    if (e instanceof AmazonStoreError && /not installed/.test(e.message)) return { state: "tables_missing", environment: cfg.environment, message: "The Amazon tables are not installed in this database yet. Apply the Amazon migration once it has been approved." };
    if (e instanceof Error && isMissingTable({ message: e.message })) return { state: "tables_missing", environment: cfg.environment, message: "The Amazon tables are not installed in this database yet." };
    throw e;
  }
}

/* ---------- connection and sync (owner/admin) ---------- */

export async function amazonVerify(): Promise<VerifyResult> {
  await requireAccess("amazon:sync");
  const cfg = configOrThrow();
  const { repo } = await repoFor(cfg);
  return verifyConnection(syncDeps(cfg, repo));
}

export async function amazonSyncStep(kind: string): Promise<StepResult> {
  await requireAccess("amazon:sync");
  if (!(SYNC_KINDS as readonly string[]).includes(kind)) throw new AmazonConfigError("Unknown sync kind");
  const cfg = configOrThrow();
  const { repo } = await repoFor(cfg);
  return syncStep(syncDeps(cfg, repo), kind as SyncKind);
}

/* ---------- insights ---------- */

/** Owner/admin only: the database also refuses an insight insert from anyone else, so a staff member cannot plant a "production" insight with invented evidence. */
export async function amazonGenerateInsights(now: Date = new Date()): Promise<{ created: number; total: number }> {
  await requireAccess("amazon:sync");
  const cfg = configOrThrow();
  const { repo } = await repoFor(cfg);
  const [lines, products, inventory, before] = await Promise.all([repo.salesLines(new Date(now.getTime() - 60 * DAY).toISOString()), repo.products(), repo.inventory(), repo.insights()]);
  const known = new Set(before.map((i) => i.dedupeKey));
  const fresh = generateInsights({ now, lines, products, inventory });
  const saved = await repo.saveInsights(fresh);
  return { created: fresh.filter((i) => !known.has(i.dedupeKey)).length, total: saved.length };
}

export type QueueInsightResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "not_found" | "already_queued" | "not_eligible" | "prohibited_claims"; error: string };

export const APPROVAL_NOTE = "Approving records a decision only. Nothing is changed on Amazon.";

export function insightPreview(i: Pick<InsightRow, "title" | "summary" | "recommendation" | "evidence">, environment: string): string {
  const lines = (i.evidence as Evidence[]).slice(0, 8).map((e) => `- ${e.metric}: ${e.value} (${e.source}${e.period ? `, ${e.period}` : ""})`);
  return [i.summary, "", `Suggested action for a person: ${i.recommendation}`, "", "Evidence:", ...lines, "", `Source: Amazon ${environment} data, rules-based insight.`, APPROVAL_NOTE].join("\n").slice(0, 5900);
}

/** Queues one insight in the existing approval workflow. Sandbox insights are refused: they describe simulated data and must not drive decisions. */
export async function amazonQueueInsight(insightId: string): Promise<QueueInsightResult> {
  await requireAccess("agents:run");
  const cfg = configOrThrow();
  const { repo, supabase, orgId } = await repoFor(cfg);
  if (!/^[0-9a-f-]{36}$/i.test(insightId)) return { ok: false, reason: "not_found", error: "Insight not found." };
  const insight = await repo.getInsight(insightId);
  if (!insight) return { ok: false, reason: "not_found", error: "Insight not found." };
  if (cfg.environment !== "production") return { ok: false, reason: "not_eligible", error: "This insight is based on Amazon sandbox (simulated) data, so it cannot be sent for approval." };
  if (insight.status === "dismissed") return { ok: false, reason: "not_eligible", error: "This insight was dismissed." };
  if (insight.status === "submitted") return { ok: false, reason: "already_queued", error: "This is already in Approvals." };

  const pending = await supabase.from("approvals").select("id").eq("org_id", orgId).eq("status", "pending").eq("meta->>ref", insight.id).limit(1);
  if (pending.error) throw new AmazonStoreError("Database request failed", pending.error.code);
  if ((pending.data ?? []).length) return { ok: false, reason: "already_queued", error: "This is already waiting in Approvals." };

  const preview = insightPreview(insight, cfg.environment);
  const violations = findProhibitedClaims(preview, []);
  if (violations.length) return { ok: false, reason: "prohibited_claims", error: `The text contains wording that needs client-approved claims: ${violations.map((v) => `${v.label}: "${v.match}"`).join("; ")}` };

  const made = await supabase.from("approvals").insert({
    org_id: orgId, title: `Amazon: ${insight.title}`.slice(0, 200), type: "Amazon insight", generated_by: "amazon", status: "pending", preview,
    meta: { kind: "amazon_insight", subject: insight.title, isSample: false, allowedClaims: [], agent: "amazon", ref: insight.id, environment: cfg.environment, insightKind: insight.kind },
  }).select("id, title, type, generated_by, status, preview, meta, created_at").single();
  if (made.error || !made.data) throw new AmazonStoreError("Database request failed", made.error?.code);
  await repo.markInsightSubmitted(insight.id, (made.data as { id: string }).id);
  await liveLog({ agent: "amazon", action: `Proposed an Amazon insight for approval: ${insight.title} (nothing changed on Amazon)` });
  return { ok: true, approval: toApproval(made.data as ApprovalRow) };
}
