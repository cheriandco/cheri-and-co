/** Mock data layer. All sample data lives here — components never import it
 *  directly; they go through src/services. */
import type {
  Activity, Agent, AmazonCompetitor, AmazonListing, AmazonPricing, AmazonReview, AmazonRow,
  Approval, AppNotification, BrandRule, ContentItem, Conversation, Customer, Deal, FunnelStage,
  Enquiry, Kpi, Product, Retailer, Task, TrendPoint, TrendSeries, User,
} from "@/types";

export const currentUser: User = { name: "Anika", role: "Founder · Admin", email: "anika@cheriandco.example" };

export const agents: Agent[] = [
  { key: "b2c", name: "B2C Sales Agent", status: "active", lastActivity: "2 min ago", actionsToday: 64, latestAction: "Replied to Priya about gold-tone necklace" },
  { key: "b2b", name: "B2B Lead Agent", status: "active", lastActivity: "11 min ago", actionsToday: 22, latestAction: "Qualified Mira Boutique, Jaipur (score 86)" },
  { key: "amazon", name: "Amazon Intelligence Agent", status: "idle", lastActivity: "1 hr ago", actionsToday: 9, latestAction: "Flagged 3 pricing gaps on layered chains" },
  { key: "content", name: "Content & Marketing Agent", status: "attention", lastActivity: "26 min ago", actionsToday: 14, latestAction: "Generated 4 reels, awaiting your review" },
  { key: "crm", name: "CRM & Sales Operations Agent", status: "active", lastActivity: "6 min ago", actionsToday: 41, latestAction: "Created 5 follow-up tasks from overnight chats" },
];

const spark = (...n: number[]) => n;
export const kpis: Kpi[] = [
  { id: "b2c", label: "B2C Enquiries", value: 482, change: 12.4, comparison: "vs 429 prior period", spark: spark(32, 38, 35, 44, 41, 52, 58, 61), href: "/b2c" },
  { id: "b2b", label: "B2B Leads", value: 67, change: 8.1, comparison: "vs 62 prior period", spark: spark(4, 6, 5, 8, 7, 9, 8, 11), href: "/b2b" },
  { id: "opp", label: "Product Opportunities", value: 18, change: -5.3, comparison: "vs 19 prior period", spark: spark(6, 5, 7, 6, 5, 6, 4, 5), href: "/amazon" },
  { id: "content", label: "Content Generated", value: 126, change: 31.2, comparison: "vs 96 prior period", spark: spark(8, 10, 12, 11, 16, 19, 22, 28), href: "/content" },
  { id: "cust", label: "Total Customers", value: 3284, change: 4.6, comparison: "vs 3,139 prior period", spark: spark(2900, 2960, 3010, 3070, 3120, 3190, 3240, 3284), href: "/customers" },
  { id: "appr", label: "Pending Approvals", value: 9, change: 2, comparison: "3 older than 24h", spark: spark(4, 6, 5, 8, 7, 11, 8, 9), href: "/approvals" },
];

export const funnel: FunnelStage[] = [
  { stage: "new", label: "New", count: 128 },
  { stage: "qualified", label: "Qualified", count: 84 },
  { stage: "contacted", label: "Contacted", count: 61 },
  { stage: "interested", label: "Interested", count: 29 },
  { stage: "won", label: "Won", count: 11 },
];

function series(n: number, labelFn: (i: number) => string, b2cBase: number, b2bBase: number): TrendPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    label: labelFn(i),
    b2c: Math.round(b2cBase + Math.sin(i / 2.3) * b2cBase * 0.28 + (i / n) * b2cBase * 0.35),
    b2b: Math.round(b2bBase + Math.cos(i / 2.9) * b2bBase * 0.35 + (i / n) * b2bBase * 0.4),
  }));
}
const dayLabel = (total: number) => (i: number) => {
  const d = new Date(Date.UTC(2026, 9, 7 - (total - 1 - i)));
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};
export const trend: TrendSeries = {
  "7d": series(7, dayLabel(7), 62, 8),
  "30d": series(30, dayLabel(30), 58, 7),
  "90d": series(30, (i) => dayLabel(90)(i * 3), 52, 6),
};

export const customers: Customer[] = [
  { id: "c1", name: "Priya Sharma", instagram: "@priya.sharma.styles", phone: "+91 98765 43210", email: "priya.sharma@example.com", city: "Mumbai", firstSeen: "12 Aug 2026", interests: ["Layered necklaces", "Gold-tone"], amazonClicks: 3, flipkartClicks: 1, purchases: 2 },
  { id: "c2", name: "Ananya Iyer", instagram: "@ananya.iyer", phone: "+91 99001 22334", email: "ananya.iyer@example.com", city: "Bengaluru", firstSeen: "28 Aug 2026", interests: ["Earrings", "Gifting"], amazonClicks: 5, flipkartClicks: 0, purchases: 1 },
  { id: "c3", name: "Riya Kapoor", instagram: "@riyakapoor_", phone: "+91 98110 55667", email: "riya.k@example.com", city: "Delhi", firstSeen: "02 Sep 2026", interests: ["Bridal sets"], amazonClicks: 0, flipkartClicks: 2, purchases: 0 },
  { id: "c4", name: "Meera Nair", instagram: "@meeranair.co", phone: "+91 97456 11890", email: "meera.nair@example.com", city: "Kochi", firstSeen: "15 Sep 2026", interests: ["Anklets", "Pearls"], amazonClicks: 2, flipkartClicks: 2, purchases: 1 },
  { id: "c5", name: "Sana Khan", instagram: "@sanakhan.edit", phone: "+91 90040 77881", email: "sana.khan@example.com", city: "Hyderabad", firstSeen: "21 Sep 2026", interests: ["Statement rings"], amazonClicks: 1, flipkartClicks: 0, purchases: 0 },
  { id: "c6", name: "Tanvi Desai", instagram: "@tanvi.desai", phone: "+91 98200 44556", email: "tanvi.d@example.com", city: "Pune", firstSeen: "30 Sep 2026", interests: ["Gift sets"], amazonClicks: 4, flipkartClicks: 1, purchases: 3 },
];

export const enquiries: Enquiry[] = [
  { id: "e1", customerId: "c1", customer: "Priya Sharma", handle: "@priya.sharma.styles", message: "Do you have this necklace in gold colour?", time: "5 min ago", status: "new", product: "Aurelia Layered Necklace", handler: "AI" },
  { id: "e2", customerId: "c2", customer: "Ananya Iyer", handle: "@ananya.iyer", message: "Can I get these earrings gift-wrapped for Diwali?", time: "18 min ago", status: "ai_replied", product: "Pearl Drop Earrings", handler: "AI" },
  { id: "e3", customerId: "c3", customer: "Riya Kapoor", handle: "@riyakapoor_", message: "Looking for a bridal set under ₹4,000 — is there a bulk discount?", time: "42 min ago", status: "needs_human", product: "Rani Bridal Set", handler: "Human" },
  { id: "e4", customerId: "c4", customer: "Meera Nair", handle: "@meeranair.co", message: "Is the anklet waterproof? I wear it daily.", time: "1 hr ago", status: "ai_replied", product: "Moonlit Anklet", handler: "AI" },
  { id: "e5", customerId: "c5", customer: "Sana Khan", handle: "@sanakhan.edit", message: "Where can I buy this ring — Amazon or Flipkart?", time: "2 hr ago", status: "resolved", product: "Celeste Cocktail Ring", handler: "AI" },
];

export const conversations: Conversation[] = enquiries.map((e) => ({
  ...e,
  messages: [
    { id: `${e.id}-m1`, from: "customer", text: e.message, time: e.time },
    { id: `${e.id}-m2`, from: e.handler === "Human" ? "human" : "ai", text: e.status === "new" ? "Draft ready: “Yes — Aurelia is available in 18k gold-tone and rose gold-tone. I’ll send you the link.”" : "Thank you for reaching out! Here are the details and a link to purchase.", time: "just now" },
  ],
}));

export const retailers: Retailer[] = [
  { id: "r1", business: "Mira Boutique", location: "Jaipur, Rajasthan", category: "Fashion boutique", score: 86, temperature: "HOT", status: "Qualified", lastActivity: "11 min ago", contact: "Mira Agarwal", email: "hello@miraboutique.example", phone: "+91 98290 12345", instagram: "@mira.boutique", website: "miraboutique.example", mapsUrl: "https://maps.google.com", qualification: "Stocks 3 competing brands; 4 stores", stage: "qualified" },
  { id: "r2", business: "The Gilded Aisle", location: "Mumbai, Maharashtra", category: "Gifting store", score: 78, temperature: "HOT", status: "Contacted", lastActivity: "2 hr ago", contact: "Farah Ali", email: "farah@gildedaisle.example", phone: "+91 98670 88776", instagram: "@gildedaisle", website: "gildedaisle.example", mapsUrl: "https://maps.google.com", qualification: "High footfall mall kiosk", stage: "contacted" },
  { id: "r3", business: "Saanvi Accessories", location: "Surat, Gujarat", category: "Accessories", score: 64, temperature: "WARM", status: "Interested", lastActivity: "Yesterday", contact: "Saanvi Patel", email: "saanvi@saanviacc.example", phone: "+91 99090 44112", instagram: "@saanvi.accessories", website: "saanviacc.example", mapsUrl: "https://maps.google.com", qualification: "Requested wholesale catalogue", stage: "interested" },
  { id: "r4", business: "Pearl & Petal", location: "Kolkata, West Bengal", category: "Jewellery boutique", score: 58, temperature: "WARM", status: "New", lastActivity: "Yesterday", contact: "Debjani Roy", email: "info@pearlpetal.example", phone: "+91 98300 77665", instagram: "@pearlandpetal.kol", website: "pearlpetal.example", mapsUrl: "https://maps.google.com", qualification: "Pending site review", stage: "new" },
  { id: "r5", business: "Chandni Gifts", location: "Lucknow, Uttar Pradesh", category: "Gift shop", score: 41, temperature: "COLD", status: "New", lastActivity: "3 days ago", contact: "Rahul Gupta", email: "chandni@gifts.example", phone: "+91 98390 55443", instagram: "@chandnigifts", website: "chandnigifts.example", mapsUrl: "https://maps.google.com", qualification: "Low social presence", stage: "new" },
  { id: "r6", business: "Ember & Ivory", location: "Pune, Maharashtra", category: "Concept store", score: 72, temperature: "WARM", status: "Negotiation", lastActivity: "4 hr ago", contact: "Kavya Menon", email: "kavya@emberivory.example", phone: "+91 98220 33221", instagram: "@emberandivory", website: "emberivory.example", mapsUrl: "https://maps.google.com", qualification: "Negotiating minimum order", stage: "negotiation" },
  { id: "r7", business: "Zari Lane", location: "Hyderabad, Telangana", category: "Ethnic wear", score: 90, temperature: "HOT", status: "Won", lastActivity: "5 days ago", contact: "Zainab Hussain", email: "zainab@zarilane.example", phone: "+91 99120 66554", instagram: "@zarilane", website: "zarilane.example", mapsUrl: "https://maps.google.com", qualification: "First order delivered", stage: "won" },
];

export const deals: Deal[] = retailers.map((r) => ({
  id: `d-${r.id}`, retailerId: r.id, business: r.business, location: r.location,
  stage: r.stage, score: r.score, owner: "Anika", updated: r.lastActivity,
}));

export const products: Product[] = [
  { id: "p1", name: "Aurelia Layered Necklace", sku: "IT-NK-001", category: "Necklaces", price: 1499, stock: 120, channels: ["Instagram", "Amazon", "Flipkart"], status: "active" },
  { id: "p2", name: "Pearl Drop Earrings", sku: "IT-ER-014", category: "Earrings", price: 899, stock: 64, channels: ["Instagram", "Amazon"], status: "active" },
  { id: "p3", name: "Rani Bridal Set", sku: "IT-BR-003", category: "Bridal", price: 3799, stock: 12, channels: ["Instagram", "B2B"], status: "low_stock" },
  { id: "p4", name: "Moonlit Anklet", sku: "IT-AN-007", category: "Anklets", price: 649, stock: 210, channels: ["Instagram", "Amazon", "Flipkart"], status: "active" },
  { id: "p5", name: "Celeste Cocktail Ring", sku: "IT-RG-022", category: "Rings", price: 749, stock: 0, channels: ["Instagram"], status: "draft" },
];

export const contentItems: ContentItem[] = [
  { id: "ct1", name: "Aurelia — Diwali Edit Reel", platform: "Instagram", type: "Reel", date: "08 Oct", status: "in_review", tone: "rose" },
  { id: "ct2", name: "Pearl Drops Gifting Carousel", platform: "Instagram", type: "Carousel", date: "09 Oct", status: "approved", tone: "pearl" },
  { id: "ct3", name: "Bridal Season Lookbook", platform: "Pinterest", type: "Post", date: "10 Oct", status: "scheduled", tone: "blush" },
  { id: "ct4", name: "Moonlit Anklet Story Set", platform: "Instagram", type: "Story", date: "11 Oct", status: "draft", tone: "sand" },
  { id: "ct5", name: "October Retailer Newsletter", platform: "Email", type: "Newsletter", date: "06 Oct", status: "published", tone: "sage", reach: 2140, engagement: 6.2 },
  { id: "ct6", name: "Celeste Ring Teaser", platform: "Instagram", type: "Reel", date: "05 Oct", status: "rejected", tone: "plum" },
  { id: "ct7", name: "Aurelia A+ Content Refresh", platform: "Amazon A+", type: "Listing", date: "04 Oct", status: "published", tone: "blush", reach: 5820, engagement: 3.4 },
  { id: "ct8", name: "Festive Stack Carousel", platform: "Instagram", type: "Carousel", date: "02 Oct", status: "published", tone: "rose", reach: 9310, engagement: 7.9 },
];

export const approvals: Approval[] = [
  { id: "a1", title: "SAMPLE · Aurelia — Diwali Edit Reel", type: "Content", generatedBy: "content", created: "26 min ago", status: "pending", preview: "15s reel · warm studio light · soft gold flare transitions. Caption: “Layer in light this Diwali ✨”", tone: "rose" },
  { id: "a2", title: "SAMPLE · Reply to Priya Sharma", type: "Instagram reply", generatedBy: "b2c", created: "5 min ago", status: "pending", preview: "“Thanks for asking! [Product details and order link to be supplied by the client.]” (SAMPLE draft)", tone: "blush" },
  { id: "a3", title: "SAMPLE · Intro email — Mira Boutique", type: "B2B outreach", generatedBy: "b2b", created: "1 hr ago", status: "pending", preview: "Subject: Wholesale partnership with Cheri & Co. — 4 stores, curated festive range…", tone: "sand" },
  { id: "a4", title: "SAMPLE · Aurelia A+ title rewrite", type: "Amazon listing", generatedBy: "amazon", created: "3 hr ago", status: "pending", preview: "“Cheri & Co. Aurelia Layered Necklace for Women — [material and features to be supplied by the client]” (SAMPLE draft)", tone: "pearl" },
  { id: "a5", title: "SAMPLE · Reduce Moonlit Anklet to ₹599", type: "Pricing change", generatedBy: "crm", created: "Yesterday", status: "pending", preview: "Market low ₹579, ours ₹649. Predicted +18% conversion, margin stays above 42%.", tone: "sage" },
];

export const amazonRows: AmazonRow[] = [
  { id: "am1", product: "Layered chain necklace", demand: "high", competition: "medium", avgPrice: 1349, opportunity: 88, recommendation: "Launch gold-tone variant at ₹1,399" },
  { id: "am2", product: "Pearl drop earrings", demand: "high", competition: "high", avgPrice: 799, opportunity: 64, recommendation: "Differentiate with gift packaging" },
  { id: "am3", product: "Silver anklet set", demand: "medium", competition: "low", avgPrice: 579, opportunity: 79, recommendation: "Add pair bundle, cut price to ₹599" },
  { id: "am4", product: "Bridal choker set", demand: "medium", competition: "medium", avgPrice: 3290, opportunity: 61, recommendation: "Hold; revisit before wedding season" },
  { id: "am5", product: "Statement cocktail ring", demand: "low", competition: "high", avgPrice: 699, opportunity: 32, recommendation: "Deprioritise" },
];

export const amazonCompetitors: AmazonCompetitor[] = [
  { id: "ac1", brand: "Zaveri Pearls", asin: "B09XK1A2LM", price: 1199, rating: 4.2, reviews: 8421, rank: "#12 Necklaces" },
  { id: "ac2", brand: "Peora", asin: "B08TT4R9QP", price: 1399, rating: 4.1, reviews: 5310, rank: "#18 Necklaces" },
  { id: "ac3", brand: "Sukkhi", asin: "B07Q3P8NUW", price: 949, rating: 4.0, reviews: 12044, rank: "#7 Earrings" },
  { id: "ac4", brand: "Priyaasi", asin: "B0BN2K91XZ", price: 599, rating: 3.9, reviews: 2980, rank: "#24 Anklets" },
];

export const amazonReviews: AmazonReview[] = [
  { id: "rv1", product: "Layered chain necklace", rating: 5, theme: "Finish", sentiment: "positive", excerpt: "Looks far more premium than the price suggests." },
  { id: "rv2", product: "Layered chain necklace", rating: 2, theme: "Tarnish", sentiment: "negative", excerpt: "Colour faded after three weeks of wear." },
  { id: "rv3", product: "Pearl drop earrings", rating: 4, theme: "Packaging", sentiment: "neutral", excerpt: "Lovely, but arrived in a plain pouch — wanted a gift box." },
  { id: "rv4", product: "Silver anklet set", rating: 5, theme: "Comfort", sentiment: "positive", excerpt: "Light and comfortable for daily use." },
];

export const amazonPricing: AmazonPricing[] = [
  { id: "ap1", product: "Aurelia Layered Necklace", ourPrice: 1499, marketLow: 1099, marketHigh: 1699, suggested: 1399 },
  { id: "ap2", product: "Pearl Drop Earrings", ourPrice: 899, marketLow: 649, marketHigh: 999, suggested: 849 },
  { id: "ap3", product: "Moonlit Anklet", ourPrice: 649, marketLow: 579, marketHigh: 749, suggested: 599 },
];

export const amazonListings: AmazonListing[] = [
  { id: "al1", product: "Aurelia Layered Necklace", asin: "B0D4CHERI1", titleScore: 72, imageScore: 85, status: "needs_work" },
  { id: "al2", product: "Pearl Drop Earrings", asin: "B0D4CHERI2", titleScore: 88, imageScore: 81, status: "live" },
  { id: "al3", product: "Moonlit Anklet", asin: "B0D4CHERI3", titleScore: 91, imageScore: 76, status: "live" },
  { id: "al4", product: "Rani Bridal Set", asin: "—", titleScore: 0, imageScore: 0, status: "draft" },
];

export const tasks: Task[] = [
  { id: "t1", title: "Follow up with Mira Boutique on wholesale catalogue", source: "B2B Lead Agent", due: "Today, 4:00 PM", priority: "high", assignee: "Anika", status: "open", href: "/retailers/r1" },
  { id: "t2", title: "Reply to Riya Kapoor — bridal bulk discount", source: "B2C Sales Agent", due: "Today, 6:00 PM", priority: "high", assignee: "Anika", status: "open", href: "/customers/c3" },
  { id: "t3", title: "Review Diwali reel before scheduling", source: "Content & Marketing Agent", due: "Tomorrow", priority: "medium", assignee: "Anika", status: "open", href: "/approvals" },
  { id: "t4", title: "Send sample box to Ember & Ivory", source: "CRM & Sales Operations Agent", due: "09 Oct", priority: "medium", assignee: "Dev", status: "open", href: "/retailers/r6" },
  { id: "t5", title: "Confirm Moonlit Anklet price change", source: "Amazon Intelligence Agent", due: "10 Oct", priority: "low", assignee: "Anika", status: "open", href: "/amazon" },
];

export const activities: Activity[] = [
  { id: "ac-1", at: "Today, 10:42", actor: "B2C Sales Agent", text: "Drafted reply about gold-tone availability" },
  { id: "ac-2", at: "Today, 09:15", actor: "CRM & Sales Operations Agent", text: "Linked Instagram handle to customer record" },
  { id: "ac-3", at: "Yesterday, 17:30", actor: "Anika", text: "Approved product recommendation message" },
  { id: "ac-4", at: "Yesterday, 11:02", actor: "B2B Lead Agent", text: "Updated lead score after website review" },
  { id: "ac-5", at: "03 Oct, 14:20", actor: "System", text: "Record created from Instagram DM" },
];

export const notifications: AppNotification[] = [
  { id: "n1", kind: "approvals", title: "9 approvals pending", detail: "3 are older than 24 hours", time: "Now", href: "/approvals" },
  { id: "n2", kind: "followups", title: "2 follow-ups due today", detail: "Mira Boutique, Riya Kapoor", time: "30 min ago", href: "/tasks" },
  { id: "n3", kind: "b2b", title: "New HOT B2B lead", detail: "Mira Boutique · score 86", time: "11 min ago", href: "/retailers/r1" },
  { id: "n4", kind: "amazon", title: "Amazon opportunity", detail: "Layered chain necklace scored 88", time: "1 hr ago", href: "/amazon" },
  { id: "n5", kind: "integration", title: "Instagram is not connected (demo)", detail: "Sample notification. No live connection exists.", time: "Today", href: "/settings" },
];

export const brandRules: BrandRule[] = [
  { id: "br1", title: "Voice", detail: "SAMPLE, not client-approved. Warm, graceful and confident. Never pushy, never slangy." },
  { id: "br2", title: "Palette", detail: "SAMPLE, not client-approved. Blush, ivory, dusty rose and warm gold. Avoid neon and heavy black." },
  { id: "br3", title: "Photography", detail: "SAMPLE, not client-approved. Soft natural light, minimal props, jewellery as hero." },
  { id: "br4", title: "Claims", detail: "SAMPLE, not client-approved. No material, plating or durability claims until the client approves the wording." },
];
