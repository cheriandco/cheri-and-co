# Phase 1 — Dashboard UI Freeze

**Status: frozen.** The current dashboard is the approved visual and structural baseline.

## Frozen (do not change without explicit approval)
- Overall layout, navigation structure and the sidebar groupings
- Design tokens and styling in `src/app/globals.css` (warm ivory / dusty rose / charcoal)
- The five-agent architecture: B2C Sales, B2B Lead, Amazon Intelligence, Content & Marketing, CRM & Sales Ops.
  The AI Business Orchestrator is a coordination layer, **not** a sixth agent.
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
| 8 | External integrations are not connected | Settings page lists Instagram, Supabase, Amazon, Higgsfield as not connected | Connect progressively; the services layer in `src/services` is the only place to change. |

## Other gaps (not UI)
- No authentication, role-based access or database row-level security yet.
- No automated tests; accessibility checked by construction only (semantic markup, labels, focus styles).
- Unknown customer/retailer ids render the not-found page with HTTP 200 (streaming behaviour).
- Tasks can be created via `POST /api/tasks` but there is no create-task form in the UI.
- No agent orchestration or realtime updates yet.
