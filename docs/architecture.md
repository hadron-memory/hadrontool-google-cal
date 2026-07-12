# hadrontool-google-cal — architecture

Status: **implemented (v1)**, pre-deploy. This tool applies the
capability-tool pattern (hadrontool-pdf → hadrontool-ms-exchange →
hadrontool-gmail lineage) to Google Calendar. The decisions it inherits were
recorded on
[hadron-server#396](https://github.com/hadron-memory/hadron-server/issues/396)
(one tool per provider, tool-owned tokens, owner-only authorization in core).

## Where this sits

`hadrontool-gmail` is the closest template: same Google OAuth handoff, same
error taxonomy, same module shapes, same Komodo/Doppler/GHCR deployment.
Read its `docs/architecture.md` for the pattern rationale; this document
focuses on what Calendar changes.

hadron-server needs a thin slice: a `PROVIDER_TOOLS['google-cal']` entry in
`emailClient.ts` (the generic provider-tool registry), an `/auth/google-cal`
connect-flow trio on the shared `mailboxConnect` machinery, calendar
operation names in the ConnectionGrant scope map, and a GraphQL calendar
surface. Connections are ordinary `ExchangeConnection` rows with
`provider: 'google-cal'` — the ConnectionGrant scope vocabulary
(`calendar.read`, `calendar.freebusy`) anticipated exactly this.

## One plane, not two (the v1 scope decision)

Unlike the email tools, v1 is **request/reply only** — no event plane:

- The calendar agent use cases (read a schedule, check availability, create/
  update events, respond to invitations) are all synchronous.
- Google Calendar push is webhook **channels** (`events.watch`) that require
  a public HTTPS endpoint **on a domain verified in the GCP project**, expire
  (~days) and need renewal, and deliver only "something changed" — a
  syncToken incremental-sync loop does the real work. That is the entire
  Gmail watch/history machinery again, for no v1 consumer.
- Skipping it makes the tool **internal-only**: it deploys on the simple
  hadrontool-pdf rails (no Traefik route, no public DNS, no domain
  verification) instead of the Gmail rails.

### v2 event-plane sketch (when a consumer exists)

Mirror the Gmail design with Calendar vocabulary: a `Watch` row per
(connection, calendarId) holding the channel id/resource id/expiry and a
**syncToken cursor**; `POST /webhooks/google-cal` public route validating the
`X-Goog-Channel-Token` per-channel secret; notifications trigger
`events.list(syncToken=cursor)` deltas; a renewal worker re-watches before
expiry; normalized `calendar.event.created|updated|cancelled` events forward
to a new core ingress. A 410 GONE on the syncToken re-baselines loudly, like
Gmail's stale historyId. None of this changes the v1 operations contract.

## Operations plane (request/reply, core → tool, internal)

`POST /ops/<operation>`, bearer-gated (`GOOGLE_CAL_TOOL_TOKEN`),
internal-only. Every operation loads the connection, decrypts the refresh
token with the tool's key, executes the Calendar call (acquiring an access
token per call with a near-expiry cache, persisting refresh-token rotation on
success AND failure — Google rarely rotates, but the plumbing is the platform
invariant), and maps failures to typed codes. A provider auth failure (401,
auth-class 403 reason, or the token endpoint's `400 invalid_grant` on
refresh) marks the connection `ERROR` so later calls short-circuit as
`connection_unauthorized` until the user reconnects.

**Idempotency**: identical to the email tools — reservation INSERT before the
mutation, payload-hash matching, release on failure, replay of completed
keys, stale-reservation reclaim.

**Operation names**: `list-events` and `get-schedule` are the names
hadron-server's `emailOperationScopes.ts` pre-mapped to the
`calendar.read` / `calendar.freebusy` grant scopes — a future ms-exchange
calendar sibling must implement the same names byte-for-byte
(`getSchedule` is the Graph equivalent of `freebusy.query`).

| Neutral operation | Google Calendar reality |
|---|---|
| `list-calendars` | `calendarList.list`, paged; `summaryOverride` wins as the display name; `canEdit` = accessRole owner/writer |
| `list-events` | `events.list` with `singleEvents=true&orderBy=startTime` (recurring events expand to instances); `start`/`end` → `timeMin`/`timeMax`; `query` → `q`; page tokens collected up to `top` |
| `get-event` | `events.get`; 410 Gone (cancelled) maps to `not_found` |
| `create-event` | `events.insert`; neutral `notifyAttendees` boolean → `sendUpdates=all\|none`; attendees are bare emails |
| `update-event` | `events.patch` (absent fields unchanged; sending `attendees` replaces the set) |
| `delete-event` | `events.delete` with `sendUpdates` |
| `respond-to-event` | no one-call RSVP: `events.get`, find the attendee entry with `self: true` (never email matching — aliases), `events.patch` the full attendee list with only that entry's `responseStatus` changed; not-an-attendee → `validation_error` |
| `get-schedule` | `freeBusy.query`; answers in request order; per-schedule provider errors become an `error` marker on that entry instead of failing the query |

The neutral event shape (`title`, `start`/`end` as dateTime-or-date,
`isAllDay`, `attendees[].response` in `accepted/declined/tentative/none`,
`myResponse`, `isOrganizer`, `seriesId`, `webLink`) is normalized in the ops
layer; nothing Google-flavored (labels like `needsAction`, `sendUpdates`,
`htmlLink`) leaks out.

## OAuth handoff (who holds what)

Same split as the email tools: hadron-server builds the authorize URL
(`GOOGLE_CAL_CLIENT_ID` is public there) and owns the callback
(`/auth/google-cal/callback`); this tool holds the **client secret**,
exchanges `{code, redirectUri}` at `POST /connections`, derives the account
identity (ID-token claims first, OpenID userinfo fallback), stores the
encrypted refresh token, and returns the identity. The identity's email
field is named `mailboxEmail` on the wire — the shared core contract
(`emailClient.ts` shape-validates it for every provider tool).

Google specifics:

- The authorize URL MUST carry `access_type=offline&prompt=consent`, or
  Google returns no refresh token (typed `validation_error` names the cause).
- Scopes: `calendar.events`, `calendar.readonly`, `openid`, `email` —
  **sensitive** scopes, NOT restricted like Gmail's. Verification is
  lighter (no CASA), but Testing status still means 7-day refresh tokens and
  a 100-user cap.
- **GCP project choice is a deploy-time decision**: a separate calendar
  project keeps calendar out of the Gmail project's restricted-scope
  verification (and vice versa: adding sensitive scopes to the verified
  Gmail client re-opens its review). Either way the client must NOT be the
  login project's client (hadron-server#583).
- Core's connect routes are `/auth/google-cal` + `/start` + `/callback` —
  `/auth/google` is login, `/auth/gmail` is mail.

## Data model

`Connection` (encrypted refresh token, status, identity) +
`IdempotencyRecord`. That's all — no watch state in v1. See
[prisma/schema.prisma](../prisma/schema.prisma).

## Deployment

Komodo build → GHCR → `komodo_default`, Doppler-injected secrets (image bakes
the Doppler CLI; Komodo sets only `DOPPLER_TOKEN`), internal-only at
`http://hadrontool-google-cal:8080` — **no public ingress**. It dials
bare-metal Postgres, so the Linux deployment needs
`--add-host=host.docker.internal:host-gateway` (see
`hadronmemory.com::dev::ops:alpha:*`). hadron-server's Doppler config gains
`GOOGLE_CAL_TOOL_URL` + `GOOGLE_CAL_TOOL_TOKEN` + `GOOGLE_CAL_CLIENT_ID`;
this tool's config holds `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (the
calendar OAuth client), `DATABASE_URL` (own database),
`TOKEN_ENCRYPTION_KEY`, and `GOOGLE_CAL_TOOL_TOKEN`.
