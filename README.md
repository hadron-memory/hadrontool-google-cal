# hadrontool-google-cal

Google Calendar tool for the Hadron platform — a standalone capability tool
that **owns the Google Calendar provider relationship**: OAuth refresh tokens
and calendar operations, behind a **provider-neutral** operations surface
over HTTP. `hadron-server` stays the front door (identity, authorization, the
calendar contract) and calls this service with already-authorized requests.

One tool per provider: this tool is Google Calendar only — the calendar
sibling of [hadrontool-gmail](https://github.com/hadron-memory/hadrontool-gmail)
(same rails, same typed error catalog, same OAuth handoff). Provider-neutrality
lives at the core boundary — hadron-server's calendar surface dispatches by
`connection.provider`, so an ms-exchange calendar sibling can implement the
same operation names later without core changes.

See [docs/architecture.md](docs/architecture.md) for the boundary, the
operations contract, and the deliberately-deferred v2 event plane.

> **Scope note.** The Calendar scopes this tool requests (`calendar.events`,
> `calendar.readonly`) are Google **sensitive** scopes — verification is
> lighter than the **restricted** Gmail scopes (no CASA assessment), but a
> production consent screen still needs sensitive-scope verification, and
> Testing status still means 7-day refresh tokens + a 100-user cap.

## Surface

| Method | Path | Plane | Purpose |
|---|---|---|---|
| `POST` | `/ops/<operation>` | internal | Provider-neutral calendar operations |
| `POST` | `/connections` | internal | Create a connection (OAuth code exchange) |
| `GET` | `/connections/:id` | internal | Connection identity + status |
| `DELETE` | `/connections/:id` | internal | Soft-delete the connection |
| `GET` | `/info` | internal | Capabilities (operation list) |
| `GET` | `/healthz` / `/readyz` | — | Liveness / readiness (readiness checks the DB) |

All internal routes require `Authorization: Bearer $GOOGLE_CAL_TOOL_TOKEN`;
in production the service refuses to start without it. **v1 has no public
route at all** — deploy internal-only, no Traefik router.

### Operations (v1)

`list-calendars`, `list-events`, `get-event`, `create-event`,
`update-event`, `delete-event`, `respond-to-event`, `get-schedule`
(free/busy).

Request body: the operation input (always includes `connectionId`, event
operations default `calendarId` to `primary`) plus an optional
`idempotencyKey` on mutating operations — a replayed key returns the stored
response without touching Google. Errors use the shared capability-tool
typed catalog (`connection_not_found`, `connection_unauthorized`,
`provider_rate_limited`, `not_found`, `validation_error`, …) as
`{ "error": "<code>", "message": "…", ...fields }`.

Contract notes:

- **Event boundaries** are `{ dateTime, timeZone }` for timed events or
  `{ date }` (YYYY-MM-DD) for all-day events — exactly one, enforced by
  schema. A zone-less `dateTime` without a `timeZone` is rejected rather
  than silently interpreted.
- **`notifyAttendees`** (boolean, default true) is the neutral form of
  Google's `sendUpdates` — whether attendees get invitation/update emails.
- **`respond-to-event`** sets the connected account's own RSVP
  (`accepted` / `declined` / `tentative`). The account must be an attendee;
  the self attendee is identified by Google's `self` flag, never by email
  matching (aliases break it).
- **`get-schedule`** is a free/busy query over one or more schedule ids
  (calendar ids / addresses the account can read; defaults to `primary`).
  A schedule Google can't resolve comes back with an `error` marker instead
  of failing the whole query.
- **`list-events`** expands recurring events into instances
  (`singleEvents=true`) and orders chronologically; instances carry a
  `seriesId`.

```bash
curl -sS -X POST http://hadrontool-google-cal:8080/ops/list-events \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $GOOGLE_CAL_TOOL_TOKEN" \
  -d '{"connectionId":"…","start":"2026-07-14T00:00:00Z","end":"2026-07-21T00:00:00Z"}'
```

## Security

- **Bearer token** gate on every internal route; required in production.
- **Refresh tokens** are AES-256-GCM-encrypted at rest under this tool's own
  `TOKEN_ENCRYPTION_KEY` (never core's key) and never leave the service.
- **No authorization logic here**: hadron-server authorizes every request
  *before* calling this tool — the tool never re-implements grants.

## Development

```bash
npm install
cp .env.example .env           # fill in what you need; see comments
createdb hadrontool_google_cal && npm run db:push
npm run dev                    # tsx watch on src/index.ts

npm test                       # vitest — requires the test DB once:
createdb hadrontool_google_cal_test && npm run db:test-setup
```

Tests run the real HTTP surface + real Postgres over a fake Google Calendar
provider — no Google credentials needed.

## Configuration

See [.env.example](.env.example). Key vars: `GOOGLE_CAL_TOOL_TOKEN`,
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` (the calendar OAuth client — never the login
project's).

## GCP setup (once per environment)

1. Pick the GCP project (see docs/architecture.md — sharing the Gmail
   mailbox project vs. a separate calendar project is a deploy-time
   decision).
2. OAuth consent screen: scopes `calendar.events`, `calendar.readonly`,
   `openid`, `email`. Testing status is fine for development (7-day refresh
   tokens, 100 users — see the warning above).
3. OAuth client (Web application): authorized redirect URI
   `https://<core BASE_URL>/auth/google-cal/callback` (+ the localhost
   variant). The client id goes to hadron-server (`GOOGLE_CAL_CLIENT_ID`),
   the secret ONLY to this tool's Doppler config.
