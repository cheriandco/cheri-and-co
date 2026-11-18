# AI drafting with OpenAI (Content & Marketing pilot)

**Status: built locally, switched OFF, never called live.** No OpenAI request has been made by this code. Owner decision (2026-11): OpenAI is the AI provider, overriding the earlier "Anthropic Claude + Canva" note for drafting.

## Scope
- Only the **Content & Marketing** agent. B2C, B2B, Amazon and CRM agents are unchanged and do not call any model.
- Only for a **signed-in live organisation** (`AUTH_MODE=required`, a role, an organisation, not flagged demo). The public demo, signed-out visitors and demo organisations always get the template generator; no key is read and no request is made.
- AI only writes five text parts (caption body, three reel on-screen lines, two story lines, one Canva headline). Links, hashtags, approved claims, the brand line, structure and review notes are built by code.
- Every AI draft is a **draft**. Submitting it creates a pending approval; a person approves it. Nothing is published, sent or stored by the model.

## Settings (all server-only; see `.env.example`)
| Variable | Default | Meaning |
|---|---|---|
| `AI_ENABLED` | `false` | Must be exactly `true` |
| `OPENAI_API_KEY` | none | Read only in `src/lib/ai/transport.ts` |
| `OPENAI_MODEL` | `gpt-6-sol` | Configurable model name |
| `OPENAI_PRICE_INPUT_USD_PER_MTOK` / `OPENAI_PRICE_OUTPUT_USD_PER_MTOK` | none | **Required.** No prices = the spend limit cannot be enforced = AI stays off |
| `AI_MONTHLY_BUDGET_USD` | `20` | Application limit (not a provider-side cap) |
| `AI_DAILY_CALLS_PER_ORG` | `100` | Per organisation, UTC day |
| `AI_CALLS_PER_USER_PER_MINUTE` | `5` | In-memory, per server instance |
| `AI_MAX_OUTPUT_TOKENS` / `AI_TIMEOUT_MS` | `1500` / `30000` | Per call |

## Safety design
1. **Redaction.** The model receives product facts only (name, category, style tags, approved claims, pack contents). Emails, phone-like numbers, links and handles are replaced before sending. No customer records are ever sent. Names of people in free text cannot be detected, which is why customer data is never in the input.
2. **No provider storage.** Requests set `store: false`, strict JSON schema, no tools.
3. **Output validation.** Text with links, hashtags, handles, personal data, markup, control characters or wrong lengths is rejected. The assembled draft then passes the existing claim guard; a draft with prohibited claims is **discarded** (template used), not edited.
4. **Spend control without a migration.** Before each call the worst-case cost is written to `agent_activity` ("AI call v1 | …") through the user's own session, then usage is re-counted. Reservations are never refunded; failed calls count. The ledger being unreadable or unwritable means no call (fail closed).
5. **Human approval.** On submit the server re-validates and re-guards any AI text the browser sends back and makes no model call.

## Limitations
- The monthly figure is an **estimate-based application limit**, not the provider's invoice. Also set a hard monthly limit in the OpenAI dashboard.
- The per-minute limiter is per server instance (best effort).
- Live catalogue rows have no style tags, material wording, approved claims or links yet, so live drafts make no such claims; links are supplied per run.
- The request shape follows the documented Responses API and is verified only against a fake transport. The first live call must be a deliberate, separately approved test.

## Checklist before ONE approved live test
1. Owner approves the live call in writing.
2. Hard monthly limit set in the OpenAI dashboard.
3. Prices entered for the chosen model; `AI_ENABLED=true` set only in the **authenticated app** environment, never the public demo project.
4. Signed-in live organisation with one real product; run one draft; check the ledger row, the draft, and that submit still needs approval.
5. Turn `AI_ENABLED` back off if anything looks wrong.

## Content Studio (Milestone 2) — Content & Marketing, live organisations only
Status: built locally and tested with a fake transport only. **No live OpenAI call has been made.** Still off unless `AI_ENABLED=true`; with it off the Studio makes template drafts.

Flow (`/content?tab=studio`): choose a catalogue product → choose Instagram caption, Facebook post, LinkedIn post, product description or campaign copy → generate → the draft is **saved immediately** as a draft → edit, save, regenerate (replaces the text) → submit for approval → a person decides in Approvals. Nothing is published or sent.

- **Context sent to the model:** the Brand Brain (`src/lib/content-studio/brand-brain.ts`: owner-confirmed facts, plus an *assumed* voice marked as style guidance only), the product's name, category and owner-written description, the audience and an optional campaign note, all passed through the redactor. **Not sent:** customer records, the image link, ids, prices, stock, marketplace links. The image link is kept in the draft's image direction as a reference for a person; the model never sees it.
- **Claims:** no approved claims exist in the database for live products, so the claim guard allows none. AI text containing a price, offer, stock, material, certification, superlative or health wording is **discarded** and a template is used instead. The description is not treated as approved claims.
- **Storage (no migration):** drafts go to `content_items`. Instagram, Facebook and LinkedIn use their own platform; **product descriptions use `Amazon A+` and campaign copy uses `Email`**, the existing allowed values nearest to them. A migration widening `content_items.platform` is needed to store them under their own names.
- **Activity history** (`agent_activity`): the AI ledger row, "Generated … / Regenerated …" (with model and prompt version), "Edited draft", "Sent … for approval", "Approved/Rejected". Approval and rejection also update the content item. The approval preview carries a "Source: AI draft …" line.
- **Limits:** the same spend ledger, per-day cap and per-minute limiter as the pilot apply; every attempt counts, including failures; a regenerate is refused (no call) once the draft is submitted.
- **Not done:** an editable, stored Brand Brain (needs a table); approved product claims; AI use of the marketplace Content Pack panel's pack records (the original Instagram pack generator still uses name and category only).
