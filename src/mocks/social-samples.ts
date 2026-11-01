/** SAMPLE social posts for the Content & Marketing Agent demo. Invented wording and invented metrics: nothing here
 *  was posted, and no real audience or performance is described. No prices, offers, stock, materials or claims. */
import type { SocialPost } from "@/types/social";

export const SOCIAL_SAMPLE_NOTE =
  "SAMPLE posts and SAMPLE metrics for demonstration. Nothing is published to Instagram, Facebook or LinkedIn, and no real audience or performance is shown.";

const TAGS = ["#CheriAndCo", "#KoreanInspired", "#MinimalJewellery"];

const post = (p: Omit<SocialPost, "isSample" | "hashtags"> & { hashtags?: string[] }): SocialPost =>
  ({ hashtags: TAGS, isSample: true, ...p });

export const socialPosts: SocialPost[] = [
  post({ id: "sp1", title: "Everyday minimal stack", topic: "Layering a minimal chain bracelet with studs", platform: "Instagram", dayOffset: -7, tone: "rose",
    caption: "Small pieces, easy mornings. Stack a slim chain bracelet with your everyday studs and you are ready to go.",
    creativeBrief: "Warm studio light, soft ivory backdrop, hands and wrist in frame. Calm, unhurried mood.",
    imageDirection: "Top-down flat lay, then a close crop of the wrist. Keep the background plain.",
    seedStatus: "simulated_published", simulatedPublished: true,
    metrics: { reach: 4120, likes: 318, comments: 24, shares: 41, clicks: 96, engagement: 9.8 } }),
  post({ id: "sp2", title: "Meet the Earring Duo", topic: "Introducing a 2-piece earring combo", platform: "Facebook", dayOffset: -5, tone: "pearl",
    caption: "Two pairs, one little box. Meet the Earring Duo, a simple pick for daily wear or for gifting.",
    creativeBrief: "Paper-box packaging shot on a pale pink surface, with both pairs laid out beside it.",
    imageDirection: "Single hero image, 4:5 crop, soft shadow, no props other than the box.",
    seedStatus: "simulated_published", simulatedPublished: true,
    metrics: { reach: 2650, likes: 142, comments: 11, shares: 19, clicks: 74, engagement: 6.5 } }),
  post({ id: "sp3", title: "Curated combo packs for retailers", topic: "Why retailers can stock 2, 3, 6 and 10 piece packs", platform: "LinkedIn", dayOffset: -4, tone: "sand",
    caption: "Retail partners often ask for easy ways to range jewellery. Our curated packs come in 2, 3, 6 and 10 pieces, so shelves stay fresh without guesswork.",
    creativeBrief: "Clean, professional layout: one pack per frame with the piece count shown clearly.",
    imageDirection: "Carousel of four frames, one per pack size, consistent ivory background.",
    seedStatus: "simulated_published", simulatedPublished: true,
    metrics: { reach: 1380, likes: 64, comments: 7, shares: 12, clicks: 41, engagement: 6.2 } }),
  post({ id: "sp4", title: "Behind the packaging", topic: "Pinterest-style paper packaging", platform: "Instagram", dayOffset: -2, tone: "plum",
    caption: "Every order is wrapped like a little gift. Here is a peek at the paper packaging.",
    creativeBrief: "Short reel: hands folding the paper box, close-up of the ribbon.",
    imageDirection: "Vertical 9:16, warm light, slow movement, no on-screen text.",
    seedStatus: "rejected" }),
  post({ id: "sp5", title: "Aurelia — Diwali Edit Reel", topic: "A festive layering reel", platform: "Instagram", dayOffset: 1, tone: "rose",
    caption: "Layer in light this Diwali.",
    creativeBrief: "15s reel, warm studio light, soft gold flare transitions.",
    imageDirection: "Vertical 9:16, close crops, gentle motion.",
    approvalId: "a1" }),
  post({ id: "sp6", title: "Gifting ideas: Curated Six", topic: "A 6-piece pack as a gift", platform: "Facebook", dayOffset: 2, tone: "blush",
    caption: "Choosing a gift is easier when the choosing is done for you. Meet the Curated Six.",
    creativeBrief: "Unboxing flat lay with the six pieces arranged in a loose circle.",
    imageDirection: "Square crop, pale pink backdrop, handwritten gift tag in frame.",
    seedStatus: "draft" }),
  post({ id: "sp7", title: "How we curate trend-stable pieces", topic: "Curating minimal jewellery that stays in style", platform: "LinkedIn", dayOffset: 4, tone: "sand",
    caption: "We pick designs that stay in style season after season. A short note on how we curate.",
    creativeBrief: "Text-led graphic with three short principles and the wordmark.",
    imageDirection: "Ivory background, charcoal text, dusty rose accent line.",
    seedStatus: "approved" }),
  post({ id: "sp8", title: "Hoop earrings, three ways", topic: "Styling hoop earrings", platform: "Instagram", dayOffset: 6, tone: "pearl",
    caption: "One pair of hoops, three moods: college, work and weekend.",
    creativeBrief: "Three quick looks in one carousel, each with a one-word label.",
    imageDirection: "Portrait crops, same pose, different outfit tones.",
    seedStatus: "draft" }),
  post({ id: "sp9", title: "Stackable ring story set", topic: "Stacking rings", platform: "Instagram", dayOffset: 9, tone: "blush",
    caption: "Stack, swap, repeat.",
    creativeBrief: "Three story frames: close-up, stacked on hand, and a poll sticker asking which stack you prefer.",
    imageDirection: "Vertical 9:16, soft focus background.",
    seedStatus: "approved" }),
  post({ id: "sp10", title: "Weekend styling", topic: "Easy weekend accessories", platform: "Facebook", dayOffset: 12, tone: "sage",
    caption: "Weekend plans, simple accessories.",
    creativeBrief: "Casual lifestyle shot with a chain and a hair clip.",
    imageDirection: "Natural light, outdoor cafe table, shallow depth of field.",
    seedStatus: "draft" }),
  post({ id: "sp11", title: "Wholesale enquiries", topic: "Inviting retailers to ask about packs", platform: "LinkedIn", dayOffset: 16, tone: "pearl",
    caption: "Running a beauty or jewellery store? We would love to hear from you about curated packs.",
    creativeBrief: "Simple announcement graphic with a contact placeholder.",
    imageDirection: "Ivory background, wordmark top left, one product image.",
    seedStatus: "draft" }),
];
