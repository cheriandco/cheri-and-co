# UX_FLOWS.md — User flows source of truth (draft for review)

**Status: DRAFT.** Describes the screens and flows that exist in the Phase 1 prototype, then the flows that were
requested in the original (IMI TIARA-era) brief and are **not** yet confirmed for Cheri & Co.
Legend as in `docs/DATABASE.md`. UI is frozen per `docs/PHASE1_UI_FREEZE.md`.

## 1. Confirmed implementation

### 1.1 Shell and navigation
Left sidebar (Cheri & Co. wordmark, then Dashboard, B2C Sales, B2B Leads, Amazon Intelligence, Content & Marketing,
CRM & Sales Ops, Approvals · Products, Customers, Retailers, Tasks & Follow-ups, Reports · Settings), top bar with search
(`Ctrl+K`) and notifications, collapsible sidebar on mobile. Route-level loading, error and not-found screens cover all pages (`src/app/(app)`), and lists and tables show empty states.
**There is no login page.** The user ("Anika") and role are hardcoded mock values.

### 1.2 Dashboard (`/dashboard`)
Greeting, date-range selector, six KPI cards, enquiries/leads trend chart (7/30/90 days), sales funnel, recent
Instagram enquiries, agent activity (five agents), pending approvals, retailer leads, content calendar, Amazon
insights, tasks. All numbers are mock.

### 1.3 Approval flow (`/approvals`, also embedded on the dashboard and content page)
`AI generated → Pending review → Approve / Reject / Edit → Execute → Completed`.
Implemented: pending review, approve, reject (confirmation with optional reason), edit, and an audit trail list.
**Not implemented:** the Execute and Completed steps (approval only changes status; nothing is executed or sent) and
persistence (state resets on server restart). An item can only be decided once while it is pending.

### 1.4 B2C Sales Agent prototype (`/b2c`)
Panel above the filters: type a customer enquiry → "Run agent (simulated)" → shows the intent, a draft reply, the
sample-catalogue recommendations, whether it escalated to a human and why, and a suggested next action.
Labelled "Prototype · sample data" and "Not sent". Below it: the (mock) conversation list and filters.
Error and validation states exist (empty input, over 1000 characters, network/server failure).

### 1.4a Content & Marketing Agent prototype (`/content`, Overview tab)
Card above the workflow strip: choose a SAMPLE product or 2/3/6/10-piece combo pack, an audience (everyday, college, working professionals, gifting) and optional Amazon/Flipkart links → "Draft content (simulated)".
The draft shows an Instagram caption, hashtags, a reel script, an ASMR script, three story frames and a Canva design brief, plus review notes (missing links, SAMPLE data), the facts used, and an "AI generated / Not published" badge.
"Send to review queue" creates a **Pending review** item in Approvals; Approve and Reject only record a decision (Approved / Rejected). The Content approval strip stops at the decision: nothing is executed or published, and nothing is posted to any platform.
Prices, discounts, stock, materials and product claims are never invented; blocked drafts cannot be submitted. Everything is labelled SAMPLE until the client supplies a real catalogue, claims and links.
Labels on screen, in order: **SAMPLE data** (not client-verified) → **AI generated** draft → **Pending review** → **Approved / Rejected**, with **Not published** shown throughout. Content approvals in Approvals carry the same badges. A pending item can be edited there; the edit is re-checked on approval. The page subtitle reads "From product to approval-ready content".
Drafting is template-based. Claude drafting is planned (reserved flag, off, not built; needs an Anthropic Console API key) and Canva is brief-only; the Settings page shows both as not connected.

### 1.5 Other flows
- **CRM** (`/crm`, 7 tabs) including a drag-and-drop pipeline board (also keyboard-operable via a hidden select). Moves call `PATCH /api/pipeline/:id`; in-memory only.
- **Tasks** (`/tasks`): complete, postpone (+1 day), reassign (Anika/Dev/Meera), open record. No create-task form in the UI.
- **Customer and retailer detail pages** with an activity timeline and tasks. The timeline currently shows the same global sample activity feed for every record (not per-record history).
- **Amazon** (8 tabs), **Content** (8 tabs with workflow strip), **Reports** (7 sections), **Products**, **Settings**: read-only mock views.
- The date selector's "Custom" option does nothing yet.

## 2. Business requirements for Cheri & Co.
Business facts (jewellery categories, single and 2/3/6/10-piece packs, audience, Amazon/Flipkart-first model with
Instagram redirects, B2B retailers, Claude + Canva for content, human-sent WhatsApp) were stated by the owner on 2026-10-29
and are recorded in `docs/BUSINESS_CONTEXT.md`, with assumptions kept separate. The owner also describes five agents plus
an orchestrator as the approved architecture; client confirmation of agent scope is still not recorded, so the agents below
stay under review. **No catalogue, price, policy, approver or process document has been supplied.**

## 3. Requested in original brief (inherited; requires client confirmation)
Each item below was specified for IMI TIARA and is **not approved** for Cheri & Co. until confirmed:
1. Five agents: B2C Sales, B2B Lead, Amazon Intelligence, Content & Marketing, CRM & Sales Operations, coordinated by an AI Business Orchestrator that is a coordination layer, not a sixth agent. *(The project owner describes this as the approved architecture; the client's own confirmation of scope is still to be recorded.)*
2. Instagram as the B2C enquiry channel.
3. Amazon and Flipkart click/purchase tracking and an Amazon Intelligence workflow.
4. B2B retailer lead discovery and a sales pipeline (New → Qualified → Contacted → Interested → Negotiation → Won → Lost).
5. Content workflow: Product Library → Brand Brain → Strategy → Calendar → Claude Creative Brain → Creative Generation → Canva Design → Human Approval → Publish/Export → Performance. (Content tooling is Claude + Canva, per the client; GPT and Higgsfield are not used. Today only template drafting and Canva briefs exist; the strip labels Claude as planned, Canva as brief-only and publishing as manual.)
6. Roles and sign-in, notification centre, reports by area.

## 4. Assumptions
1. A human approves anything an agent drafts before it reaches a customer (consistent with the prototype's "draft only" behaviour).
2. Escalation always routes to a named human; the target person or queue is not yet defined.
3. Desktop-first, with tablet/mobile support.

## 5. Open questions (client)
1. Which of the five agents does Cheri & Co. want first, and in what order? Is B2B relevant at all?
2. Is Instagram the right customer channel? Which others (WhatsApp, website chat, email)?
3. Does Cheri & Co. sell on Amazon and/or Flipkart? Is marketplace intelligence in scope?
4. Will the client create an Anthropic Console account and API key with usage billing (a Claude Team plan alone is not API access)? Which Canva plan is used, and does it allow the automation we need? (GPT and Higgsfield are out of scope.)
5. Policies the agent must reflect: returns/exchanges, shipping and delivery, discounts and offers, care instructions. Until supplied, the agent states that verified information is unavailable and escalates.
6. Who handles escalations, during what hours, and what response time is expected?
7. Brand voice, tone and claims rules for replies (e.g. terms that must not be used).
8. Languages needed.
9. Who approves content and replies, and is more than one approval level needed?
10. What should happen after approval (the "Execute" step): send through which channel?

## 5a. Social media flow (demo, inside Content & Marketing)
Create Post (title, topic, platform, caption, hashtags, creative brief, image direction; optional demo assistant) → Save draft →
Submit for approval (demo) → Approvals (Approve or Reject, simulated) → Simulate publish (demo) → Published and Performance (SAMPLE metrics).
The Content Calendar shows a five-week grid with platform and status. Nothing is posted; every label says so.

## 6. Dependencies
Answers to §5; client-owned accounts for each integration; authentication and roles (`docs/API.md` §5);
a real product catalogue (`docs/DATABASE.md` §4); a staging environment for user-acceptance testing.
