# Phase 1 — Dashboard UI Freeze

**Status: frozen.** The current dashboard is the approved visual and structural baseline.

## Frozen (do not change without explicit approval)
- Overall layout, navigation structure and the sidebar groupings
- Design tokens and styling in `src/app/globals.css` (warm ivory / dusty rose / charcoal)
- The five-agent architecture: B2C Sales, B2B Lead, Amazon Intelligence, Content & Marketing, CRM & Sales Ops.
  The AI Business Orchestrator is a coordination layer, **not** a sixth agent.
  *This is a build rule set by the project owner (do not add or remove agents during Phase 1). Client confirmation that these five agents are the Cheri & Co. scope has not been recorded; see `docs/UX_FLOWS.md` §5.*
- No new agents, no new design system, no redesign.

Remaining work is wiring (data, auth, persistence, integrations), not UI rebuilds. Visual changes are
only acceptable to fix a clear functional inconsistency.

## Known Phase 1 limitations (documented, not redesigned)

| # | Limitation | Where | Required later behaviour |
|---|------------|-------|--------------------------|
| 1 | Greeting/name is hardcoded ("Anika") | `src/services/index.ts` (`getCurrentUser`), `src/mocks/data.ts` (`currentUser`) | Derive from the authenticated session. |
| 2 | Audit actor is hardcoded ("Anika") | `src/app/api/approvals/[id]/[action]/route.ts` (TODO(auth)) | Actor = authenticated user id; audit rows must be server-written and immutable. |
| 3 | KPI values are mock data | `src/mocks/data.ts` (`kpis`), `getDashboardSummary` | Computed from CRM/database queries. "Pending Approvals" already reflects live in-memory approval state. |
| 4 | Date-range controls are mock behaviour | `RangeSelect`, `RANGE_FACTOR` in `getDashboardSummary` | Today/7/30/90 must filter real queries. Currently only scales four KPI counts; the funnel, lists and the trend chart ignore it (the trend chart has its own 7/30/90 toggle). |
| 5 | Custom date range is not functional | `RangeSelect` ("Custom" button) | Add a date-range picker and pass `from`/`to` to the API. Currently behaves like 7 Days. |
| 6 | B2B line on the trend chart uses a ×4 visual scale | `TrendChart` in `src/components/charts.tsx` | B2B volumes are far smaller than B2C, so B2B is plotted at 4× on the shared axis. The legend says "×4 scale" and the tooltip shows true values, but the **Y-axis labels are B2C values only**. Consider a secondary axis if this proves confusing. |
| 7 | Approval, task and pipeline state is not persistent | `src/services/store.ts` (in-memory, `globalThis`) | Persist to Supabase; resets on server restart today. Audit log likewise. |
| 8 | External integrations are not connected | Settings page lists Instagram, Supabase, Amazon, Anthropic Claude (API), Canva as not connected | Connect progressively; the services layer in `src/services` is the only place to change. |

## Dependency audit finding (development tooling only)
`npm audit` reports one moderate advisory, GHSA-g3hv-75wg-m249 (`minimatch`, denial of service through glob amplification; affected: `<11.0.1`).
- **Where:** transitive only. `minimatch` is pulled in by `eslint`, `eslint-config-next` and `typescript-eslint`; it is not a direct dependency and is not in the production runtime or the Next.js build output.
- **Fix `npm audit` suggests:** `npm audit fix --force`, which installs `eslint@4.0.0`. That is a breaking, obsolete downgrade and is **not** used.
- **No upstream fix yet:** the latest `eslint` (10.14.0), `eslint@9` and `@typescript-eslint/typescript-estree` (8.72.1) all depend on `minimatch` 3.x or 10.x.
- **Tested, non-breaking workaround (not applied, needs approval):** adding `"overrides": { "minimatch": "^11.0.3" }` to `package.json`. In a scratch copy this gave 0 audit findings, with lint, typecheck and all tests passing. It does change `package.json` and the lockfile, so it waits for owner approval.
- **Recommended:** approve the override, or wait for an eslint/typescript-eslint release that depends on `minimatch` 11 and drop it then.

## Other gaps (not UI)
- No authentication, role-based access or database row-level security yet.
- Automated tests cover the B2C Sales Agent prototype (35 tests) and the Content & Marketing Agent (71 tests, including approval states, Claude configuration and no-live-integration guards); the dashboard pages, API route handlers and task/pipeline flows have none. Accessibility was checked by construction only (semantic markup, labels, focus styles).
- Unknown customer/retailer ids render the not-found page with HTTP 200 (streaming behaviour).
- Tasks can be created via `POST /api/tasks` but there is no create-task form in the UI.
- No agent orchestration or realtime updates yet.

## Additions after the freeze commit (`db8fab2`), recorded in `3b15f34` and the working tree
The baseline layout, navigation, design tokens and five-agent architecture are unchanged. These were added without redesign:

- **B2C Sales Agent prototype** (`/b2c`): one card above the filter bar, using existing components and classes only. Rule-based, draft-only, sample catalogue, nothing sent or stored. API: `POST /api/agents/b2c/run`. Tests: `npm test` (35).
- **Cheri & Co. branding:** the sidebar text brand is replaced by the supplied wordmark (`public/brand/`), in a pale-pink chip so it reads on the dark sidebar; favicon and Apple icon are crops of the original artwork. The product was renamed from the inherited IMI TIARA name in titles, README, package name and sample text.
- **Content & Marketing Agent prototype** (`/content`, Overview tab): one card above the workflow strip, using existing components and classes. Template-based, draft-only, SAMPLE data, nothing posted anywhere. Related small changes, each approved by the owner: the Content workflow strip and Settings integrations list now show Claude (planned) and Canva (brief only) instead of Higgsfield and GPT, the Content subtitle reads "From product to approval-ready content", and inherited sample approvals and Brand Brain rules are labelled SAMPLE with the invented "anti-tarnish" and "free gift wrap" wording removed; approvals can only be decided once (`409` otherwise); the approval note no longer says "queued for execution" (nothing executes); Content approvals show a three-step strip that ends at the decision; the approval edit limit is 6000 characters. API: `POST /api/agents/content/run` and `/submit`. Tests: `tests/content-agent.test.ts`.
- **Dependencies:** `next` 16.4.1 (security patch), `vitest` (dev), transitive `zod` 4.6.7 (security patch, dev tooling only).
- **Limitations list above still applies.** The hardcoded user and audit actor ("Anika") are placeholder values that predate the rename; they are not a real Cheri & Co. user. The B2C prototype adds no persistence, authentication or live integration.
- **Source-of-truth documents:** `docs/DATABASE.md`, `docs/API.md` and `docs/UX_FLOWS.md` (drafts; inherited IMI TIARA assumptions are flagged as needing client confirmation).
