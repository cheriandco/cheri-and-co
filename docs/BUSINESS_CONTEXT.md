# BUSINESS_CONTEXT.md — Cheri & Co. business facts (draft for review)

**Status: DRAFT.** Records what the Cheri & Co. owner has told us, kept apart from what we have assumed.
Legend as in `docs/DATABASE.md`. Source of every "Confirmed" item: the project owner's written description,
2026-10-29. These are owner-stated facts, not yet verified against client documents.

## 1. Confirmed by the owner

### Business model
- Everyday fashion accessories, sold from **on-stock inventory** (not a cash-burning direct-to-consumer model).
- Sells to consumers (B2C) **and** to businesses (B2B).
- Curated concepts that stay in trend; explicitly not fast fashion.

### Product categories
Korean-inspired, minimal CZ (cubic zirconia) and AD (American diamond) jewellery and accessories:
bracelets, chain pendants, earrings, chains, rings, hair accessories, and watch combos.
Affordable but premium-looking, with medium and premium quality tiers.

### Pack formats
- Sold as **single pieces** and as **combo packs of 2, 3, 6 and 10 pieces**, plus mixed curations.
- Pinterest-inspired paper packaging, digitally printed in small runs matched to the number of pieces
  (example from the owner: 12 pieces → 12 boxes). Regular items use standard packaging.

### Sourcing and range
- Bhopal and Indore wholesale first, then national wholesalers, manufacturers and importers, later direct from China.
- Limited quantities with frequent new stock, to avoid dead stock.
- Designs chosen from best-seller research on Amazon, Flipkart, Etsy and Myntra.

### Target audience
College-going girls and working professionals; all-tier India with a focus on tier-2 and tier-3 cities; budget gifting.

### Sales channels and growth plan
1. List on **Amazon and Flipkart first**.
2. Instagram content (ASMR, lifestyle, influencer) that **redirects to Amazon/Flipkart** via affiliate links.
3. Meta, Amazon and Flipkart ads.
4. **B2B** to offline beauty and jewellery retailers (exclusive curated sets, quantity basis), a B2B-only online portal for
   verified retailers with bulk pricing, leads from Meta/Google Ads and field sales.
5. Later: Amazon Global/B2B and the UAE, UK and US.

### Tooling decisions
- Content creation uses **Anthropic Claude + Canva** (client-confirmed 2026-10-31). This replaces the earlier GPT/OpenAI
  plan and the earlier Higgsfield idea; neither is used (cost control).
- **Claude subscription vs API:** a Claude Team subscription gives people access to Claude's own apps. It does **not**
  include API access. A production integration needs an **Anthropic Console API key** and **separate usage billing**.
  We do not assume the client has either, and no API key has been requested or is used.
- **Canva** stays at the **design-brief stage**: the agent produces structured creative briefs for a person to build in
  Canva. Nothing is created, edited or published in Canva automatically, and we do not assume the client's plan has
  API or automation access until it is verified.
- B2B WhatsApp messages are **prepared for a human to send**, never auto-sent.

## 2. Brand positioning (derived from §1)
The statements below are a faithful summary of the owner's description, not a client-approved brand guide.
Wording for tone is an **assumption** until the owner supplies brand guidelines (see §4).
- Positioning: affordable, premium-looking, Korean-inspired minimal jewellery for everyday wear and gifting.
- Pinterest-style, aesthetic, gift-ready presentation.

## 3. Assumptions (not confirmed)
1. Brand voice: warm, youthful, aspirational and simple; avoids hard-sell and unverifiable claims. *(Assumed, to be replaced by client guidelines.)*
2. 60-day retention for text conversations. *(Proposed by us; not agreed.)*
3. Roles: owner approves all agent drafts until the client names approvers.
4. Currency is INR for India; multi-currency is later.
5. A pack's contents are described only by what the client supplies; the system never infers materials or plating.

## 4. Not yet supplied (do not invent)
Real catalogue (SKUs, names, prices, MRP, GST, MOQ, stock); pack definitions; product materials and approved product claims
(e.g. anti-tarnish, waterproof, hypoallergenic); Amazon/Flipkart/affiliate links; return, shipping and discount policies;
brand guidelines and tone rules; languages (Hindi/Hinglish?); named approvers and escalation contacts; client's existing
website, hosting and database; Meta/WhatsApp/Amazon/Canva approvals; an Anthropic Console account, API key and usage
billing decision; the client's Canva plan and whether it allows API or automation access.

## 5. Content & Marketing technology status
| Area | Implemented (works today, local prototype) | Planned (not built) | Requires client access or approval |
|---|---|---|---|
| Drafting | Template generator: caption, hashtags, reel and ASMR scripts, stories, Canva brief, for SAMPLE products and 2/3/6/10-piece packs | Claude drafting and refinement, server-side, behind the reserved flag `CONTENT_AGENT_USE_CLAUDE` (default off) | Anthropic Console account, API key and usage billing (separate from any Claude Team plan) |
| Design | Structured Canva design brief inside each draft | Canva automation, only if the plan and API allow it | Client's Canva plan and permissions verified |
| Safeguards | Claim guard, link allowlist, edit re-check, decide-once approvals | Same safeguards applied to Claude output | Approved product claims and brand guidelines |
| Approval | AI generated → Pending review → Approved / Rejected, audit trail | Persistence in Supabase, named approvers | Approver names and rules |
| Publishing | None. Approval records a decision only | Manual publishing by a person; any automation needs separate approval | Instagram, Amazon and Flipkart permissions, if automation is ever wanted |
| Data | SAMPLE records, in memory | Real catalogue and links | Catalogue, claims, marketplace and affiliate links |
| Workflow automation | None | n8n, as integrations are added | Hosting and access decisions |
