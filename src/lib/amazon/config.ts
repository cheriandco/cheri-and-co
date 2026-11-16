/** Amazon SP-API configuration, read from server-side environment variables only. Nothing here is ever sent to the browser.
 *
 *  Variables (names only; values are never logged, stored or returned):
 *    AMAZON_SP_ENVIRONMENT     "sandbox" (default) or "production"
 *    AMAZON_LWA_CLIENT_ID      the private app's Login with Amazon client id
 *    AMAZON_LWA_CLIENT_SECRET  its client secret
 *    AMAZON_SP_REFRESH_TOKEN   the refresh token produced by the seller's self-authorization
 *    AMAZON_SELLER_ID          the seller (merchant) id, needed by the Listings API
 *    AMAZON_MARKETPLACE_ID     defaults to Amazon India, A21TJRUUN4KGV (verified against the API at connection time)
 *
 *  The sandbox is the default on purpose: forgetting to set the variable can never point the app at production data. */

export type AmazonEnvironment = "sandbox" | "production";

/** Amazon India. Its stores use the Europe SP-API region. */
export const INDIA_MARKETPLACE_ID = "A21TJRUUN4KGV";
export const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/** The only hosts the client will ever send an access token to. A poisoned environment value therefore cannot redirect credentials. */
export const SP_API_HOSTS: Record<AmazonEnvironment, string> = {
  production: "https://sellingpartnerapi-eu.amazon.com",
  sandbox: "https://sandbox.sellingpartnerapi-eu.amazon.com",
};

export interface AmazonCredentials { clientId: string; clientSecret: string; refreshToken: string }

/** Everything except the secrets. Safe to log, serialise and show. */
export interface AmazonPublicConfig {
  environment: AmazonEnvironment;
  region: "eu";
  marketplaceId: string;
  sellerId: string;
  baseUrl: string;
}

export interface AmazonConfig extends AmazonPublicConfig {
  /** The only way to reach the secrets. They are not enumerable properties, so `JSON.stringify`, spreading or logging the config cannot leak them. */
  credentials(): AmazonCredentials;
}

export type AmazonConfigStatus =
  | { ok: true; config: AmazonConfig }
  | { ok: false; missing: string[]; invalid: string[] };

const REQUIRED = ["AMAZON_LWA_CLIENT_ID", "AMAZON_LWA_CLIENT_SECRET", "AMAZON_SP_REFRESH_TOKEN", "AMAZON_SELLER_ID"] as const;

type Env = Record<string, string | undefined>;

export function amazonConfigStatus(env: Env = process.env): AmazonConfigStatus {
  const get = (k: string) => env[k]?.trim() || "";
  const missing: string[] = REQUIRED.filter((k) => !get(k));
  const invalid: string[] = [];

  const rawEnv = get("AMAZON_SP_ENVIRONMENT") || "sandbox";
  if (rawEnv !== "sandbox" && rawEnv !== "production") invalid.push("AMAZON_SP_ENVIRONMENT must be sandbox or production");
  const marketplaceId = get("AMAZON_MARKETPLACE_ID") || INDIA_MARKETPLACE_ID;
  if (!/^[A-Z0-9]{8,16}$/.test(marketplaceId)) invalid.push("AMAZON_MARKETPLACE_ID is not a marketplace id");
  const sellerId = get("AMAZON_SELLER_ID");
  if (sellerId && !/^[A-Z0-9]{6,32}$/.test(sellerId)) invalid.push("AMAZON_SELLER_ID is not a seller id");
  if (missing.length || invalid.length) return { ok: false, missing, invalid };

  const environment = rawEnv as AmazonEnvironment;
  const secrets: AmazonCredentials = { clientId: get("AMAZON_LWA_CLIENT_ID"), clientSecret: get("AMAZON_LWA_CLIENT_SECRET"), refreshToken: get("AMAZON_SP_REFRESH_TOKEN") };
  const config: AmazonConfig = Object.defineProperty(
    { environment, region: "eu" as const, marketplaceId, sellerId, baseUrl: SP_API_HOSTS[environment] },
    "credentials",
    { value: () => ({ ...secrets }), enumerable: false },
  ) as AmazonConfig;
  return { ok: true, config };
}

/** Plain-language reason for the settings page and the dashboard. Names variables, never values. */
export function describeConfigProblem(status: Extract<AmazonConfigStatus, { ok: false }>): string {
  const parts: string[] = [];
  if (status.missing.length) parts.push(`missing: ${status.missing.join(", ")}`);
  if (status.invalid.length) parts.push(status.invalid.join("; "));
  return `Amazon is not configured (${parts.join("; ")}).`;
}

/** Throws unless the host is one of the two Amazon endpoints. Called by the client before every request. */
export function assertAllowedBaseUrl(baseUrl: string): void {
  if (baseUrl !== SP_API_HOSTS.production && baseUrl !== SP_API_HOSTS.sandbox) throw new Error("Refusing to call a host that is not an Amazon SP-API endpoint");
}
