/** Pure text normalisers shared by scoring and duplicate detection. The phone key matches the CSV import (`src/lib/import.ts`): last 10 digits. */

/** Lower-case, accents removed, anything that is not a letter or digit becomes a space. */
export function normaliseText(s: string | undefined | null): string {
  if (!s) return "";
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function tokens(s: string | undefined | null): string[] {
  const n = normaliseText(s);
  return n ? n.split(" ") : [];
}

/** Whole-word match (also the simple plural) for a single word or a phrase. "gold" matches "Gold Palace" and "Golds", never "Marigold". */
export function hasWord(name: string | undefined | null, word: string): boolean {
  const w = normaliseText(word);
  if (!w) return false;
  const padded = ` ${normaliseText(name)} `;
  return padded.includes(` ${w} `) || padded.includes(` ${w}s `) || padded.includes(` ${w}es `);
}

export function hasAnyWord(name: string | undefined | null, words: readonly string[]): boolean {
  return words.some((w) => hasWord(name, w));
}

/** Last 10 digits when at least 7 are present (the same rule as the CSV import); otherwise unknown. */
export function phoneKey(raw: string | undefined | null): string | undefined {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : undefined;
}

/** Hosts that say nothing about which business owns a page, so a shared host is never evidence of a duplicate. */
const SHARED_HOSTS = new Set(["facebook.com", "instagram.com", "linktr.ee", "wa.me", "whatsapp.com", "google.com", "goo.gl", "g.page", "business.site", "youtube.com", "linkedin.com", "x.com", "twitter.com", "justdial.com", "indiamart.com", "sulekha.com", "wixsite.com", "blogspot.com", "weebly.com", "shopify.com", "myshopify.com"]);

/** True when the value parses as a web address with a dotted host. A social page counts as a public contact route (unlike for duplicate matching). */
export function hasUsableUrl(raw: string | undefined | null): boolean {
  const t = (raw ?? "").trim();
  if (!t) return false;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname.includes("."); } catch { return false; }
}

/** Registrable-looking host without "www.", or undefined when the value is not a usable website or is a shared platform. */
export function websiteDomain(raw: string | undefined | null): string | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  let host = "";
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return undefined; }
  host = host.replace(/^www\./, "");
  if (!host.includes(".")) return undefined;
  for (const shared of SHARED_HOSTS) if (host === shared || host.endsWith(`.${shared}`)) return undefined;
  return host;
}
