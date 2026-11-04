/** Claim guard. Scans copy for statements the agent must never make on its own.
 *  - "never" rules (price, discount, stock) cannot be unlocked by any approved claim.
 *  - "approvable" rules (materials, finishes, certifications, superlatives) are allowed only when the
 *    matched text appears inside a claim the client approved for that product. */

export type ClaimRule = "price" | "discount" | "stock" | "material" | "precious" | "certification" | "superlative" | "medical";

interface Rule { id: ClaimRule; label: string; approvable: boolean; pattern: RegExp }

const RULES: Rule[] = [
  { id: "price", label: "price", approvable: false,
    pattern: /(?:₹|\brs\.?|\binr\b|\busd\b|\$)\s?\d|\b\d[\d,]*\s?(?:rupees|rs\b|inr\b)|\bstarting (?:at|from)\b|\bunder\s+(?:₹|rs\b|\d)/gi },
  { id: "discount", label: "discount or offer", approvable: false,
    pattern: /\b\d{1,3}\s?%\s?(?:off|discount)|\b(?:discounts?|on sale|sale|coupon|promo ?code|cashback|buy \d+ get \d+|limited[- ]time (?:offer|deal)|special offer|free (?:gift|shipping|delivery))\b/gi },
  { id: "stock", label: "stock or scarcity", approvable: false,
    pattern: /\b(?:in stock|out of stock|sold out|only \d+ left|last \d+ pieces?|few (?:pieces|left)|selling fast|limited stock|limited edition|almost gone|hurry)\b/gi },
  { id: "material", label: "material or durability", approvable: true,
    pattern: /\b(?:water[- ]?proof|water[- ]?resistant|sweat[- ]?proof|anti[- ]?tarnish|tarnish[- ]?(?:free|proof|resistant)|non[- ]?tarnish|rust[- ]?(?:free|proof)|hypoallergenic|skin[- ]?safe|nickel[- ]?free|lead[- ]?free|allergy[- ]?free|fade[- ]?proof|never fades?|long[- ]lasting|lifetime)\b/gi },
  { id: "precious", label: "precious metal or plating", approvable: true,
    pattern: /\b(?:real|genuine|pure|authentic) (?:gold|silver|diamonds?|platinum)\b|\b(?:925|sterling) silver\b|\b(?:14|18|22|24)\s?k(?:t|arat)?\b|\b(?:gold|silver)[- ]plated\b/gi },
  { id: "certification", label: "certification", approvable: true,
    pattern: /\b(?:certified|hallmark(?:ed)?)\b/gi },
  { id: "superlative", label: "guarantee or superlative", approvable: true,
    pattern: /\b(?:best price|lowest price|cheapest|guarantee(?:d)?|100\s?%|best[- ]?sellers?|bestselling|number one)\b|#1\b/gi },
  { id: "medical", label: "health claim", approvable: true,
    pattern: /\b(?:cures?|heals?|therapeutic|anti[- ]?allergic)\b/gi },
];

/** Read-only view of the rules, so tests can check that the SQL copy (supabase/migrations/*_security_hardening.sql) has not drifted. */
export const CLAIM_RULES: readonly { id: ClaimRule; label: string; approvable: boolean; source: string }[] =
  RULES.map((r) => ({ id: r.id, label: r.label, approvable: r.approvable, source: r.pattern.source }));

export interface ClaimViolation {
  rule: ClaimRule;
  label: string;
  match: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Text normalisation applied before the rules run, so that look-alike spellings cannot slip past them. The database applies the
 *  same steps in the same order (private.normalize_claim_text); a test fails if the two copies drift.
 *  1. Unicode NFKD, drop combining accents (U+0300 to U+036F), NFKC: fullwidth letters and percent signs, ligatures, no-break and
 *     other special spaces become their plain forms, and an accent mark added to a letter of "guarantee" is dropped.
 *  2. Cyrillic and Greek letters that look like Latin letters become the Latin letter.
 *  3. Invisible characters (soft hyphen, zero-width space/joiner, word joiner, BOM) are removed.
 *  4. Every kind of dash becomes "-".
 *  5. Any run of whitespace (including line breaks) becomes one space. */
export const CLAIM_NORMALISATION = {
  accents: "[\\u0300-\\u036F]",
  confusableFrom: "АВЕКМНОРСТХаеорсухіјѕԁԛԝΑΒΕΖΗΙΚΜΝΟΡΤΥΧοανι",
  confusableTo: "ABEKMHOPCTXaeopcyxijsdqwABEZHIKMNOPTYXoavi",
  invisible: "[\\u00AD\\u180E\\u200B-\\u200D\\u2060\\uFEFF]",
  dashes: "[\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]",
  space: "[\\s\\u0085\\u2028\\u2029]+",
} as const;

const CONFUSABLES = new Map(Array.from(CLAIM_NORMALISATION.confusableFrom).map((ch, i) => [ch, Array.from(CLAIM_NORMALISATION.confusableTo)[i]]));

export function normalizeClaimText(text: string): string {
  const base = text.normalize("NFKD").replace(new RegExp(CLAIM_NORMALISATION.accents, "g"), "").normalize("NFKC");
  return Array.from(base).map((ch) => CONFUSABLES.get(ch) ?? ch).join("")
    .replace(new RegExp(CLAIM_NORMALISATION.invisible, "g"), "")
    .replace(new RegExp(CLAIM_NORMALISATION.dashes, "g"), "-")
    .replace(new RegExp(CLAIM_NORMALISATION.space, "g"), " ");
}

/** Returns every prohibited statement in `text`, minus matches covered by `approvedClaims` (approvable rules only). */
export function findProhibitedClaims(text: string, approvedClaims: string[] = []): ClaimViolation[] {
  const approved = approvedClaims.map(norm);
  const out: ClaimViolation[] = [];
  const clean = normalizeClaimText(text);
  for (const rule of RULES) {
    for (const m of clean.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      const match = norm(m[0]);
      if (rule.approvable && approved.some((a) => a.includes(match))) continue;
      out.push({ rule: rule.id, label: rule.label, match: m[0] });
    }
  }
  return out;
}
