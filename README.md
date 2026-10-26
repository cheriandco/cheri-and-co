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

## B2C Sales Agent (prototype, Agent 1)

Deterministic, rule-based agent in `src/lib/b2c-agent/` (intent → preferences → catalogue search → draft + escalation). Sample catalogue (clearly labelled, not verified) lives in `src/mocks/catalogue.ts`. UI: panel at the top of `/b2c`; API: `POST /api/agents/b2c/run`. It only drafts replies; nothing is sent, stored or connected to Instagram/Supabase/auth. Run `npm test` for the agent tests.
