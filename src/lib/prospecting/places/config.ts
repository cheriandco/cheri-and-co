/** Places client configuration. Only the kill switch is read from the environment, and only the exact text "true" turns it on.
 *  No API key is read, stored or passed here: the client never sees a credential. A real transport (a later phase, needing
 *  approvals R3, R4 and R5) would hold the key itself. */

export interface PlacesConfig { enabled: boolean }

export function loadPlacesConfig(env: Record<string, string | undefined> = process.env): PlacesConfig {
  return { enabled: env.GOOGLE_PLACES_ENABLED === "true" };
}

export interface RateLimit { /** requests per second */ rate: number; burst: number }

/** A deliberately cautious local pace. Google's real limits are unverified until Phase 8; Google-side quota caps are the hard stop. */
export const DEFAULT_RATE_LIMIT: RateLimit = { rate: 5, burst: 5 };
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_WAIT_MS = 2_000;
export const DEFAULT_MAX_PAGES = 3;
export const MAX_PAGE_SIZE = 20;
