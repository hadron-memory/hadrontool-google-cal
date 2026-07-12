# Agent dev guide — hadrontool-google-cal

**hadrontool-google-cal** is an independently-deployed **Google Calendar tool** for the
Hadron platform: it owns the Google Calendar provider relationship — OAuth refresh
tokens and calendar operations — behind a **provider-neutral, agent-agnostic** HTTP
surface. Core (hadron-server) keeps the contract, identity, and authorization; this
tool does the provider transformation. **One tool per provider**: this is the calendar
sibling of `hadrontool-gmail`; provider-neutrality lives at the core boundary
(dispatch by `connection.provider`), not inside a multi-provider tool.

**Status: implemented (v1), pre-deploy.** Design: [docs/architecture.md](docs/architecture.md).
v1 is the operations plane only — **no event plane, no public routes** (the deliberate
scope cut that lets this deploy on the internal-only rails; the v2 watch-channel sketch
is in the architecture doc).

## Commands

```bash
npm run dev          # tsx watch (port 8080)
npm test             # vitest — real HTTP + Postgres over a FAKE Calendar provider
npm run typecheck
npm run db:push      # sync the tool's own DB (dev)
npm run db:test-setup # one-time: schema into hadrontool_google_cal_test
```

Local DBs: `hadrontool_google_cal` (dev, via `.env`), `hadrontool_google_cal_test`
(pinned by vitest.config.ts — tests never touch dev data).

**Prisma 7** (engine-less; differs from hadron-server's Prisma 6): the CLI
connection URL lives in `prisma.config.ts` (NOT in the schema datasource
block); the runtime client connects through `@prisma/adapter-pg` (src/db.ts);
the generated client is TypeScript under `src/generated/prisma/` (gitignored —
`prisma generate` runs in typecheck/pretest/build); `db push` no longer
auto-generates.

## Structure

- `src/ops/` — the provider-neutral operation registry (typed errors, one zod schema
  per op parsed by `defineOp`); `POST /ops/<operation>`, reservation-based idempotency
  for mutating ops; the neutral-event normalization (`normalizeEvent`) lives here.
  `list-events` / `get-schedule` are the names hadron-server's ConnectionGrant scope
  table pre-mapped — a future ms-exchange calendar sibling implements the same names.
- `src/providers/googlecal/` — the ONLY Google-specific layer (`GoogleCalProvider`
  interface in `types.ts`; REST impl in `client.ts`; OAuth in `auth.ts`). Tests inject
  fakes from `src/test/fakes.ts`.
- `src/routes/` — `ops` (internal), `connections` (internal; OAuth-code exchange +
  identity + soft-delete), all bearer-gated via `src/middleware/auth.ts`.
- `src/connectionCall.ts` — the ONE lifecycle wrapper (load → decrypt → call →
  persist rotation on success AND failure → typed mapping, ERROR-marking on dead
  grants). Every provider call goes through it.
- `src/errors.ts` — the typed catalog (shared capability-tool codes) + the Google
  error mapper (429/403-quota → rate-limited; 401/403-auth → unauthorized; 404/**410**
  → not_found; other 403 → transient, never bricks the connection).

## Things to know before editing

- **The identity JSON returned by `POST /connections` uses `mailboxEmail`** — that is
  the shared core contract (hadron-server's `emailClient.ts` shape-validates it for
  every provider tool). Internally the column is `accountEmail`.
- **Event boundaries are either/or by schema**: `{dateTime[, timeZone]}` XOR `{date}`;
  a zone-less dateTime without timeZone is rejected. Don't relax this — Google would
  silently interpret it in the calendar's zone.
- **`respond-to-event` finds the self attendee by Google's `self: true` flag**, never
  by email comparison (aliases and group invitations break email matching).
- **Never let `sendUpdates`/`needsAction`/other Google vocabulary leak** out of the
  ops layer — the neutral surface is `notifyAttendees: boolean` and
  `accepted/declined/tentative/none`.
- Keep parity with the sibling tools when touching shared-shape modules
  (`config`/`crypto`/`connectionCall`/`middleware`/idempotency in `ops/index.ts`) —
  they are deliberate copies across hadrontool-* repos; fix a bug in all of them.
