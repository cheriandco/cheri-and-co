/** Marketplace link validation. Only links the user supplies are ever used; none are generated. */

const AMAZON_HOSTS = ["amazon.in", "www.amazon.in", "amzn.in", "amzn.to", "amazon.com", "www.amazon.com"];
const FLIPKART_HOSTS = ["flipkart.com", "www.flipkart.com", "dl.flipkart.com", "fkrt.it", "fkrt.cc"];

export const MAX_LINK_LENGTH = 500;

export type LinkResult = { ok: true; url: string } | { ok: false; reason: string };

/** Accepts only https links on the marketplace's own hosts (affiliate short links included), without credentials. */
export function checkMarketplaceLink(marketplace: "amazon" | "flipkart", raw: string): LinkResult {
  const value = raw.trim();
  if (!value || value.length > MAX_LINK_LENGTH) return { ok: false, reason: `Enter a ${marketplace} link of up to ${MAX_LINK_LENGTH} characters.` };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, reason: `The ${marketplace} link is not a valid URL.` }; }
  if (url.protocol !== "https:") return { ok: false, reason: `The ${marketplace} link must start with https://.` };
  if (url.username || url.password) return { ok: false, reason: `The ${marketplace} link must not contain a username or password.` };
  const hosts = marketplace === "amazon" ? AMAZON_HOSTS : FLIPKART_HOSTS;
  if (!hosts.includes(url.hostname.toLowerCase())) return { ok: false, reason: `That is not a recognised ${marketplace} link host.` };
  return { ok: true, url: value };
}
