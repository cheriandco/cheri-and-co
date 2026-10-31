# Cheri & Co. — AI Commerce & Business Operations Dashboard

Next.js (App Router) + TypeScript. Plain CSS design system, no UI framework.

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck && npm run lint && npm run build
```

## Structure
- `src/types` — typed domain models (map 1:1 to future Supabase tables)
- `src/mocks/data.ts` — the only place sample data lives
- `src/services` — service boundary; swap mock → API → Supabase here only
- `src/app/api` — route handlers (validated input, approval audit log)
- `src/components` — `ui` primitives, `domain` components, `interactive` (client), `charts`, `shell`
- `src/app/globals.css` — design tokens + styles

## Architecture
Five business agents (B2C Sales, B2B Lead, Amazon Intelligence, Content & Marketing, CRM & Sales Ops)
coordinated by the AI Business Orchestrator (a coordination layer, **not** a sixth agent), all writing to the
central CRM/database; the dashboard is the human-approval interface on top.

## Not built yet (planned phases)
Authentication/RBAC and RLS, real Supabase persistence, agent orchestration, realtime, tests.
Mutations (approvals, tasks, pipeline) currently persist to an in-memory store that resets on server restart.

Business facts and assumptions: `docs/BUSINESS_CONTEXT.md`. Content tooling is **Anthropic Claude + Canva** (no GPT, no Higgsfield).

## Content & Marketing Agent (prototype)

Template-based drafts (caption, hashtags, reel and ASMR scripts, stories, Canva brief) for SAMPLE products and 2/3/6/10-piece packs, in `src/lib/content-agent/`; SAMPLE data in `src/mocks/content-samples.ts`. UI: card at the top of `/content`; API: `POST /api/agents/content/run` and `/submit`. Draft-only: approval records a decision, and nothing is posted anywhere. No prices, discounts, stock, materials or claims are invented. Tests: `tests/content-agent.test.ts`.

| | Implemented | Planned | Requires client access or approval |
|---|---|---|---|
| Claude | none (a reserved flag `CONTENT_AGENT_USE_CLAUDE`, default off, only adds a "not built" note) | server-side drafting and refinement, same claim guard and approval flow | Anthropic Console API key and usage billing. A Claude Team subscription is **not** API access |
| Canva | design brief text in every draft | automation, only if the plan and API allow | client's Canva plan and permissions verified |
| Drafting, safeguards, approval | template drafts, claim guard, link allowlist, decide-once approvals, audit trail (in memory) | Supabase persistence, named approvers | approved claims, real catalogue, marketplace links |
| Publishing | none; approval never posts anywhere | manual by a person | permissions, only if automation is ever wanted |

Security: keys stay server-side and are not read by any code today; `.env.example` holds blank placeholders only. The moderate dev-only `minimatch` audit advisory (GHSA-g3hv-75wg-m249) is addressed by an `overrides` entry (`minimatch ^11.0.3`) in `package.json`; `npm audit` reports 0 vulnerabilities. Details in `docs/PHASE1_UI_FREEZE.md`.

## B2C Sales Agent (prototype, Agent 1)

Deterministic, rule-based agent in `src/lib/b2c-agent/` (intent → preferences → catalogue search → draft + escalation). Sample catalogue (clearly labelled, not verified) lives in `src/mocks/catalogue.ts`. UI: panel at the top of `/b2c`; API: `POST /api/agents/b2c/run`. It only drafts replies; nothing is sent, stored or connected to Instagram/Supabase/auth. Run `npm test` for the agent tests.
