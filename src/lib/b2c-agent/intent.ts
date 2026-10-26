import type { B2CIntent } from "@/types/b2c-agent";

export interface IntentResult {
  intent: B2CIntent;
  confidence: number;
}

export const normalise = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}₹.,\s#-]/gu, " ").replace(/\s+/g, " ").trim();

/** Pre-purchase question about care/durability ("will it tarnish?"), as opposed to a complaint about a received item. */
const CARE_QUESTION = /\b(will|would|does|do|can|could|is|are|won'?t|doesn'?t|how long)\b.{0,30}\b(tarnish\w*|fad(e|es|ing)|rust\w*|discolou?r\w*|turn (black|green)|last)\b/;
const POST_PURCHASE = /\b(i (bought|ordered|received|got|purchased)|i have|my (order|item|purchase|parcel|package|necklace|ring|earrings|bracelet|anklet|set)|arrived|already|has (tarnished|faded|rusted)|have (tarnished|faded|rusted)|tarnished|rusted|faded|discoloured|discolored|turned)\b/;
/** Return/exchange/refund asked as a policy question before buying (not a request about an existing order). */
const RETURN_WORD = /\b(refund\w*|return(s|ing|ed)?|exchange|money back|replace(ment)?)\b/;
const PREPURCHASE_POLICY = /\b(return|refund|exchange) policy\b|\b(want|going|planning|thinking|like|wish|wanna|about) (to )?(buy|order|purchase)\b|\bbefore (i )?(buy|order|purchase|buying|ordering|purchasing)\b|\bif i (buy|order|purchase)\b|\bdo you (accept|allow|offer|have|provide) (returns?|exchanges?|refunds?)\b|\b(are|is) (returns?|exchanges?|refunds?) (allowed|possible|accepted|available)\b/;
const POST_PURCHASE_RETURN = /\b(i (bought|ordered|received|got|purchased)|my (order|item|purchase|parcel|package)|arrived|delivered|damaged|wrong|already)\b/;

/** Ordered rules: safety-relevant intents (complaint, refund, order status) win over sales intents. */
const RULES: { intent: B2CIntent; re: RegExp; confidence: number }[] = [
  { intent: "complaint", re: /\b(complain\w*|damaged|broken|defective|faulty|wrong (item|product|size)|poor quality|disappointed|terrible|worst|not happy|unhappy|bad experience|scam|fraud|fake|rude|tarnish\w*|turned (black|green)|rusted?|fad(ed|ing)|discolou?red|peel(ed|ing))\b/, confidence: 0.9 },
  { intent: "return_refund", re: /\b(refund\w*|return(s|ing|ed)?|exchange|money back|replace(ment)?|cancel\w*)\b/, confidence: 0.9 },
  { intent: "order_status", re: /\b(track\w*|awb|dispatch\w*|shipped|shipping status|delivery (date|status)|not (yet )?(been )?(received|delivered|arrived))\b|\bwhere('?s| is) my (order|parcel|package|shipment)\b|\b(my|the) order\b|\border (id|number|no|status)\b|\bwhen will (it|my \w+) (arrive|be delivered|reach)\b/, confidence: 0.9 },
  { intent: "shipping_enquiry", re: /\b(shipping|delivery|deliver\w*|courier|postage|cod|cash on delivery|ship to|ships? (to|internationally)|dispatch time|international)\b/, confidence: 0.85 },
  { intent: "discount_enquiry", re: /\b(discounts?|offers?|coupons?|promo\w*|promotions?|sale|deals?|cashback|bulk (order|discount)|best price|lowest price|bargain|negotiat\w+|cheaper|reduce (the )?price|any scheme)\b/, confidence: 0.85 },
  { intent: "purchase_link_request", re: /\b(link|url)\b.*\b(buy|purchase|order|product|it|this)\b|\b(buy|purchase|order)\b.*\b(link|url)\b|\bsend (me )?(the )?link\b|\blink (please|pls|plz)\b|\bhow (do|can) i (buy|order|purchase)\b|\bwhere (can|do) i (buy|order|purchase|get)\b|\bcheckout\b/, confidence: 0.85 },
  { intent: "availability_enquiry", re: /\b(in stock|out of stock|stock|availability|sold out|restock\w*|is (it|this|that) available|are (they|these|those) available|still available)\b/, confidence: 0.85 },
  { intent: "price_enquiry", re: /\b(price|prices|pricing|cost|costs|how much|rate)\b/, confidence: 0.85 },
  { intent: "product_details", re: /\b(tell me (more )?about|more (info|details|information)|details?|describe|made (of|from)|material|what is (it|this)|specifications?|features?|dimensions?|weight|size|carat|hypoallergenic|waterproof)\b/, confidence: 0.8 },
];

const CATEGORY_WORD = /\b(rings?|necklaces?|pendants?|chains?|chokers?|ear ?rings?|studs?|hoops?|jhumkas?|bracelets?|bangles?|kadas?|anklets?|payals?|sets?)\b/;
const OCCASION_STYLE_WORD = /\b(wedding|bridal|shaadi|party|festive|festival|diwali|navratri|eid|daily|everyday|office|work|birthday|anniversary|gift|minimal\w*|traditional|ethnic|statement|classic|boho|bohemian|elegant)\b/;
const RECO_VERB = /\b(recommend\w*|suggest\w*|show me|looking for|want|need|find|any|best|ideas?|options?|something|what should i)\b/;

export function classifyIntent(enquiry: string): IntentResult {
  const text = normalise(enquiry);
  if (!text) return { intent: "other", confidence: 0 };
  if (CARE_QUESTION.test(text) && !POST_PURCHASE.test(text)) return { intent: "product_details", confidence: 0.8 };
  if (RETURN_WORD.test(text) && PREPURCHASE_POLICY.test(text) && !POST_PURCHASE_RETURN.test(text)) return { intent: "return_policy_enquiry", confidence: 0.85 };
  for (const r of RULES) if (r.re.test(text)) return { intent: r.intent, confidence: r.confidence };

  const hasCategory = CATEGORY_WORD.test(text);
  const hasOccasionStyle = OCCASION_STYLE_WORD.test(text);
  if (hasOccasionStyle && !hasCategory) return { intent: "occasion_style_recommendation", confidence: RECO_VERB.test(text) ? 0.85 : 0.7 };
  if (hasCategory) return { intent: "product_recommendation", confidence: RECO_VERB.test(text) ? 0.85 : 0.7 };
  if (RECO_VERB.test(text) && /\b(jewell?ery|accessor\w+)\b/.test(text)) return { intent: "product_recommendation", confidence: 0.6 };
  return { intent: "other", confidence: 0.2 };
}
