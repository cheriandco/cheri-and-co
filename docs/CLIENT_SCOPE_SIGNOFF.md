# Cheri & Co.: client scope sign-off (M0)

> **DRAFT — AWAITING CLIENT WRITTEN APPROVAL**
>
> This document has **not** been approved. It records the scope as reconstructed from the repository, `docs/FINAL_DELIVERY_ROADMAP.md` and the
> project history. **M0 is not complete** until the client supplies written approval. No approval, signature, name or date appears below on
> purpose; the fields at the end are blank and must be filled in by the client, not by the engineer.

Related documents: `docs/FINAL_DELIVERY_ROADMAP.md` (effort and sequence), `docs/APP_DEPLOYMENT_PREPARATION.md` (hosting decisions),
`docs/STAGING_SETUP_AND_VERIFICATION.md` (M1), `docs/SECURITY_HARDENING_REPORT.md` (database hardening prepared for M1).

**Provenance note.** No signed proposal existed in the repository when the roadmap was written. The agreed scope below is therefore a
reconstruction, and the purpose of this document is to replace that reconstruction with the client's written confirmation.

---

## A. Approved platform architecture (to be confirmed)

The platform has **five agents**, one coordinating layer, one central database and one approval interface. There is **no sixth agent**.

| # | Component | Role |
|---|---|---|
| 1 | **B2C Sales Agent** | Understands customer enquiries (Instagram is the enquiry channel), recommends products from the real catalogue, prepares a reply for a person to approve and send, escalates what it cannot answer. |
| 2 | **B2B Lead Agent** | Retailer leads and the pipeline (New to Won/Lost), follow-up drafts prepared for a person to send. |
| 3 | **Amazon Intelligence Agent** | Amazon/Flipkart intelligence (opportunities, competitors, reviews, pricing, listings, recommendations) from client-supplied data. |
| 4 | **Content & Marketing Agent** | Content and social drafts (Social Media is part of this agent, not a separate agent), claim checks, manual publishing by a person. |
| 5 | **CRM & Sales Ops Agent** | Customers, retailers, products, orders, tasks, activity and reports. |
| — | **AI Business Orchestrator** | A coordination layer over the five agents (summary, recommendations, cross-agent activity). It is not an agent. |
| — | **Central CRM/database** | One Supabase database that all agents read and write, separated by organisation, with role-based access. |
| — | **Dashboard and human approval workflow** | The single interface. Nothing reaches a customer, marketplace or platform without a person approving it. Nothing is sent or published automatically. |

Roles: owner, admin, approver, staff, viewer.
Hosting: the client's own authenticated application at `app.cheri.co.in`; the existing demo remains unchanged.

---

## B. Frozen deliverables and milestones

Estimates are **copied unchanged** from `docs/FINAL_DELIVERY_ROADMAP.md` section F. They are engineering estimates in working days, excluding client
response time, Meta/Amazon approvals, DNS propagation and billing setup. No new estimate is introduced here.

| Milestone | Deliverable | Roadmap estimate |
|---|---|---|
| **M0** | Client scope sign-off (this document) | 0.5 days |
| **M1** | Hosted staging verification of the database-connected Slices 1 to 4, including the prepared database security hardening | 2.5 days |
| **M2** | CRM forms and CSV imports (customer, retailer, task and order forms; CSV import for customers and orders) | 5.0 days |
| **M3** | Agent suggestions and approval workflow for live organisations (B2C, B2B and Amazon suggestions reach Approvals) | 2.0 days |
| **M4** | Live B2C Sales Agent (stored conversations, manual enquiry entry, drafts, escalation, approval) | 8.0 days |
| **M5** | Live Amazon Intelligence (client data import, the eight views, rule-based recommendations, approval) | 9.0 days |
| **M6** | Live B2B follow-up drafts | 1.5 days |
| — | Integration pass (Orchestrator, dashboard, labels, sample-data leak checks) | 1.5 days |
| **M7** | Staging, then production deployment | 3.0 days |
| **M8** | Client acceptance testing and handover | 3.0 days |
| | **Mandatory total (unchanged from the roadmap)** | **about 36 days (range 30 to 44)** |

Already built and tested locally (not part of the remaining estimate, and **not yet verified on a hosted database**): the five-agent demo, the database
foundation with sign-in and roles, and live data for tasks, approvals, customers, retailers, leads, products, social posts and orders with a Sales report.

---

## C. Client responsibilities (inputs and access the client must supply)

The delivery depends on these. Items not supplied are listed as open in the roadmap (section D) and block the milestone shown.

| Input | Needed for |
|---|---|
| **Product catalogue**: SKUs, names, categories, prices/MRP, stock, pack definitions, materials, images | M4, M2, Content, Orders |
| **Brand rules and approved claims**: voice and tone, languages, words that must not be used, and the product claims the client is willing to stand behind (for example anti-tarnish, waterproof, hypoallergenic) | Content, M4, claim checks |
| **Return, shipping and discount policies**, offers and care instructions | M4 (otherwise the agent states it cannot verify and escalates) |
| **Named approvers and their roles**, an escalation owner, working hours, and who enters data | Roles, M3, M4 |
| **Amazon/Flipkart exports** (Seller Central or Brand Analytics reports as CSV), the ASIN/listing list and affiliate links, **or** API credentials if the client chooses that route | M5 |
| **Domain ownership and DNS access** for `cheri.co.in` | M7 |
| **Billing and account owners** for the hosting and database plans (Vercel and Supabase) | M7 |
| **Required integration access**, only where the client has chosen that route (see section D) | As stated per item |
| Existing website, database or backups, if any (to be inspected before assuming a fresh start) | M7, M2 |
| A short list of real test scenarios and a named contact for acceptance testing | M8 |

---

## D. Explicit exclusions

The following are **not** part of this scope and will not be built, configured or proposed under it without a separate written approval:

- **Vyapar integration** — parked pending client approval.
- **Meta integration** (Instagram/Facebook automated intake, webhooks, app review) — dependent on client access and client approval; not part of the mandatory scope. Instagram enquiries are entered manually in M4.
- **Additional agents** beyond the five above.
- **Unapproved dashboard modules** or screens beyond the data-entry forms in M2, M4 and M5.
- **Unapproved integrations or scope additions** of any kind.

Also out of scope (from `docs/FINAL_DELIVERY_ROADMAP.md` section J): automatic sending of customer replies; automatic posting to Instagram, Facebook,
LinkedIn or any marketplace; WhatsApp automation (messages are prepared for a person to send); ad management; billing/Stripe; dealer or customer
self-serve onboarding; multi-tenant administration screens; web scraping of marketplaces; mobile apps; MFA and password-reset flows (optional only);
and any change to the existing demo.

---

## E. Acceptance criteria

Every milestone ends with a green typecheck, lint, test suite and production build. Tests must show organisation isolation, role refusal, separation
of the demo from real data, and that no sample record is visible to the real organisation. Hosted checks use the single staging Owner account; other
roles and cross-organisation isolation are proven by automated suites and SQL fixtures. Criteria for M1 to M8 are taken from `docs/FINAL_DELIVERY_ROADMAP.md`
section G; the M1 security criteria were added with the prepared hardening.

| Milestone | Measurable acceptance criteria |
|---|---|
| **M0** | The client has confirmed sections A to D in writing, with name and date supplied by the client. |
| **M1** | Real sign-in succeeds and lands on the dashboard; a wrong password gives the generic error; the database filters used by Slices 1 to 4 return correct rows on staging; a duplicate SKU gives a conflict; a cross-organisation link is refused; submitting content creates an approval and deciding it updates the post; `docs/rls_live_check.sql` passes completely on staging; `docs/security_hardening_live_check.sql` passes completely on staging; the Supabase Security Advisor shows no new warning. **A staging project and the client's go-ahead to create it are required; until then M1 is prepared, not complete.** |
| **M2** | A non-technical user creates a customer, retailer, task and order from the screen; invalid input shows a message; a viewer is refused; a CSV with a bad row reports the row and imports nothing partially. |
| **M3** | A B2C, B2B or Amazon suggestion appears in Approvals with the real submitter; duplicates are refused; a decision writes an audit row; nothing is sent or changed outside the application. |
| **M4** | A staff member enters an enquiry; the draft, intent and escalation reason appear; order-status, refund and complaint enquiries escalate; the draft never states an unverified price, stock or claim; "Submit for approval" creates a pending approval; the conversation persists after refresh; another organisation cannot read it. |
| **M5** | Importing a client export populates all eight views with that data only; the page states the source and date of the import; recommendations cite the rule used; "send to approval" works; with no import the page says so instead of showing samples. |
| **M6** | A follow-up draft for a real retailer is generated, reviewed and approved; nothing is sent. |
| **Integration pass** | The Orchestrator shows real counts for all five agents; no sample name appears anywhere for the real organisation. |
| **M7** | The deployment checklist in `docs/APP_DEPLOYMENT_PREPARATION.md` (go/no-go section) is fully ticked; staging passed before production. |
| **M8** | The client signs the acceptance sheet naming exactly what is live and what is not. |

---

## F. Open dependencies that can change this scope

- B2C Sales and Amazon Intelligence are **launch blockers** unless they are delivered or the client accepts, in writing, that they are not live at launch.
- M4 and M5 each need a database change that requires separate approval before it is applied.
- M4 and M5 cannot be accurate without the client inputs in section C.

---

## G. Client approval (to be completed by the client only)

By approving, the client confirms sections A to F: the five-agent architecture, the milestone list, the client responsibilities, the exclusions and
the acceptance criteria.

| | |
|---|---|
| Approved by (name) | _blank — to be written by the client_ |
| Role | _blank_ |
| Decision (approved / approved with changes / not approved) | _blank_ |
| Changes requested | _blank_ |
| Date | _blank_ |
| Signature or written confirmation reference | _blank_ |

**Status: DRAFT. M0 is not complete.**
