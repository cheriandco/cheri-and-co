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

export interface ClaimViolation {
  rule: ClaimRule;
  label: string;
  match: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Returns every prohibited statement in `text`, minus matches covered by `approvedClaims` (approvable rules only). */
export function findProhibitedClaims(text: string, approvedClaims: string[] = []): ClaimViolation[] {
  const approved = approvedClaims.map(norm);
  const out: ClaimViolation[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      const match = norm(m[0]);
      if (rule.approvable && approved.some((a) => a.includes(match))) continue;
      out.push({ rule: rule.id, label: rule.label, match: m[0] });
    }
  }
  return out;
}
