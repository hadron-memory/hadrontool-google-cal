/**
 * Provider-neutral operations — the calendar operations contract.
 *
 * Operation names follow the spec 002 style the email tools use, and two of
 * them (`list-events`, `get-schedule`) are the names hadron-server's
 * ConnectionGrant scope table pre-mapped (src/lib/emailOperationScopes.ts) —
 * a future ms-exchange calendar sibling must implement the same names
 * byte-for-byte. hadron-server calls POST /ops/<name>; nothing
 * Google-specific leaks out of this layer (sendUpdates is a neutral boolean,
 * response statuses use the neutral accepted/declined/tentative vocabulary).
 *
 * Every operation's input is validated ONCE against its single schema
 * (defineOp parses before the handler runs), then executed through
 * withConnection (src/connectionCall.ts) — the shared load/decrypt/rotate/
 * error-map lifecycle.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import { withConnection } from '../connectionCall.js';
import { isUniqueViolation, type Db } from '../db.js';
import { ValidationError, toCalendarToolError } from '../errors.js';
import { logError } from '../logger.js';
import type { GoogleCalEvent, GoogleCalProvider, GoogleResponseStatus } from '../providers/googlecal/types.js';

/** Provider-neutral attendee response vocabulary. */
export type EventResponse = 'accepted' | 'declined' | 'tentative' | 'none';

/** Provider-neutral event shape returned by every read surface. */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string | null;
  description: string | null;
  location: string | null;
  /** Exactly one of dateTime (timed) or date (all-day) is set. */
  start: { dateTime: string | null; date: string | null; timeZone: string | null };
  end: { dateTime: string | null; date: string | null; timeZone: string | null };
  isAllDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizer: { name: string | null; address: string | null } | null;
  /** True when the connected account organized the event. */
  isOrganizer: boolean;
  attendees: { name: string | null; address: string; optional: boolean; response: EventResponse }[];
  /** The connected account's own response; null when it is not an attendee. */
  myResponse: EventResponse | null;
  webLink: string | null;
  /** Series id when this is an instance of a recurring event. */
  seriesId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Map Google's responseStatus to the neutral vocabulary. */
function neutralResponse(status: GoogleResponseStatus): EventResponse {
  return status === 'needsAction' ? 'none' : status;
}

/** Normalize a parsed Google event to the neutral shape. */
export function normalizeEvent(e: GoogleCalEvent): CalendarEvent {
  const self = e.attendees.find((a) => a.self);
  return {
    id: e.id,
    calendarId: e.calendarId,
    title: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    isAllDay: e.start.date !== null,
    status: e.status,
    organizer: e.organizer ? { name: e.organizer.displayName, address: e.organizer.email } : null,
    isOrganizer: e.organizer?.self ?? false,
    attendees: e.attendees
      .filter((a) => !a.resource)
      .map((a) => ({
        name: a.displayName,
        address: a.email,
        optional: a.optional,
        response: neutralResponse(a.responseStatus),
      })),
    myResponse: self ? neutralResponse(self.responseStatus) : null,
    webLink: e.htmlLink,
    seriesId: e.recurringEventId,
    createdAt: e.created,
    updatedAt: e.updated,
  };
}

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  mutating: boolean;
  schema: z.ZodType;
  run(db: Db, provider: GoogleCalProvider, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Define an operation with ONE schema: defineOp parses the raw input against
 * it and hands the handler the typed result — there is no second, shadow
 * schema inside the handler to drift from the declared contract.
 */
function defineOp<S extends z.ZodType>(
  mutating: boolean,
  schema: S,
  handler: (db: Db, provider: GoogleCalProvider, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    mutating,
    schema,
    run: (db, provider, raw) => handler(db, provider, schema.parse(raw)),
  };
}

const connectionIdSchema = z.object({ connectionId: z.string().min(1) });

/** Every event operation may target a non-primary calendar. */
const calendarScopedSchema = connectionIdSchema.extend({
  calendarId: z.string().min(1).default('primary'),
});

const eventRefSchema = calendarScopedSchema.extend({ eventId: z.string().min(1) });

const listEventsSchema = calendarScopedSchema.extend({
  /** RFC 3339 window bounds (inclusive lower / exclusive upper). */
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  top: z.number().int().min(1).max(100).optional(),
});

/**
 * An event boundary: exactly ONE of `dateTime` (timed) or `date` (all-day) —
 * the either/or lives IN the schema so the declared contract and the
 * enforced one cannot drift. `timeZone` is required alongside `dateTime`
 * unless the value carries its own UTC offset.
 */
const eventTimeSchema = z
  .object({
    dateTime: z.string().min(1).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'all-day dates use YYYY-MM-DD')
      .optional(),
    timeZone: z.string().min(1).optional(),
  })
  .refine((t) => (t.dateTime !== undefined) !== (t.date !== undefined), {
    message: 'exactly one of dateTime or date is required',
  })
  .refine((t) => !t.dateTime || t.timeZone !== undefined || /(Z|[+-]\d{2}:?\d{2})$/.test(t.dateTime), {
    message: 'a dateTime needs a timeZone unless it carries a UTC offset',
  });

const attendeesSchema = z.array(z.string().min(3).includes('@', { message: 'attendees are email addresses' })).max(100);

const createEventSchema = calendarScopedSchema.extend({
  title: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventTimeSchema,
  end: eventTimeSchema,
  attendees: attendeesSchema.optional(),
  /** Whether the provider emails attendees about the change. */
  notifyAttendees: z.boolean().default(true),
});

const updateEventSchema = eventRefSchema.extend({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventTimeSchema.optional(),
  end: eventTimeSchema.optional(),
  attendees: attendeesSchema.optional(),
  notifyAttendees: z.boolean().default(true),
});

const deleteEventSchema = eventRefSchema.extend({
  notifyAttendees: z.boolean().default(true),
});

const respondSchema = eventRefSchema.extend({
  response: z.enum(['accepted', 'declined', 'tentative']),
});

const getScheduleSchema = connectionIdSchema.extend({
  start: z.string().min(1),
  end: z.string().min(1),
  /** Calendar ids / addresses to check; defaults to the account's primary. */
  schedules: z.array(z.string().min(1)).min(1).max(20).default(['primary']),
});

/** Map the neutral notify boolean to Google's sendUpdates vocabulary. */
function notifyValue(notify: boolean): 'all' | 'none' {
  return notify ? 'all' : 'none';
}

/** The v1 operation registry, keyed by neutral operation name. */
export const OPERATIONS: Record<string, OperationDef> = {
  'list-calendars': defineOp(false, connectionIdSchema, async (db, provider, input) => {
    const calendars = await withConnection(db, input.connectionId, undefined, (token) => provider.listCalendars(token));
    return { calendars };
  }),

  'list-events': defineOp(false, listEventsSchema, async (db, provider, input) => {
    const events = await withConnection(db, input.connectionId, { resource: 'calendar', id: input.calendarId }, (token) =>
      provider.listEvents(token, input.calendarId, {
        start: input.start,
        end: input.end,
        query: input.query,
        top: input.top,
      }),
    );
    return { events: events.map(normalizeEvent) };
  }),

  'get-event': defineOp(false, eventRefSchema, async (db, provider, input) => {
    const event = await withConnection(db, input.connectionId, { resource: 'event', id: input.eventId }, (token) =>
      provider.getEvent(token, input.calendarId, input.eventId),
    );
    return { event: normalizeEvent(event) };
  }),

  'create-event': defineOp(true, createEventSchema, async (db, provider, input) => {
    const event = await withConnection(db, input.connectionId, { resource: 'calendar', id: input.calendarId }, (token) =>
      provider.createEvent(
        token,
        input.calendarId,
        {
          title: input.title,
          description: input.description,
          location: input.location,
          start: input.start,
          end: input.end,
          attendees: input.attendees,
        },
        notifyValue(input.notifyAttendees),
      ),
    );
    return { event: normalizeEvent(event) };
  }),

  'update-event': defineOp(true, updateEventSchema, async (db, provider, input) => {
    const event = await withConnection(db, input.connectionId, { resource: 'event', id: input.eventId }, (token) =>
      provider.updateEvent(
        token,
        input.calendarId,
        input.eventId,
        {
          title: input.title,
          description: input.description,
          location: input.location,
          start: input.start,
          end: input.end,
          attendees: input.attendees,
        },
        notifyValue(input.notifyAttendees),
      ),
    );
    return { event: normalizeEvent(event) };
  }),

  'delete-event': defineOp(true, deleteEventSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'event', id: input.eventId }, (token) =>
      provider.deleteEvent(token, input.calendarId, input.eventId, notifyValue(input.notifyAttendees)),
    );
    return { deleted: true };
  }),

  'respond-to-event': defineOp(true, respondSchema, async (db, provider, input) => {
    const event = await withConnection(db, input.connectionId, { resource: 'event', id: input.eventId }, (token) =>
      provider.respondToEvent(token, input.calendarId, input.eventId, input.response),
    );
    return { event: normalizeEvent(event) };
  }),

  'get-schedule': defineOp(false, getScheduleSchema, async (db, provider, input) => {
    const schedules = await withConnection(db, input.connectionId, undefined, (token) =>
      provider.querySchedule(token, input.start, input.end, input.schedules),
    );
    return { schedules };
  }),
};

/** An in-flight reservation older than this is considered orphaned (the
 *  process died between the INSERT and the response update) and may be
 *  reclaimed by a retry — otherwise a crash blocks the key until the 7-day
 *  ledger prune. Well above any real request duration. */
const STALE_RESERVATION_MS = 5 * 60 * 1000;

/** Recursively key-sort a value so semantically equal inputs hash equal. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

/** Stable SHA-256 of an operation input for idempotency-payload matching.
 *  Exported for tests that need to seed matching reservation rows. */
export function hashInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

/**
 * Execute an operation by name with reservation-based idempotency: a
 * mutating call carrying an `idempotencyKey` first INSERTS an in-flight
 * reservation (unique key), so a concurrent duplicate cannot also execute
 * the provider mutation — it sees the reservation and is told to retry. A
 * completed key replays the stored response; a key reused with a different
 * operation or payload is rejected instead of leaking the stored response.
 * An in-flight reservation past the staleness cutoff (crashed process) is
 * reclaimed atomically so a retry can execute instead of waiting for the
 * ledger prune.
 */
export async function runOperation(
  db: Db,
  provider: GoogleCalProvider,
  name: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ result: unknown; replayed: boolean }> {
  const op = OPERATIONS[name];
  if (!op) throw new ValidationError('operation', `unknown operation "${name}"`);

  const useIdempotency = Boolean(idempotencyKey) && op.mutating;
  const requestHash = useIdempotency ? hashInput(input) : '';

  if (useIdempotency) {
    try {
      await db.idempotencyRecord.create({
        data: { key: idempotencyKey!, operation: name, requestHash, responseJson: null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey! } });
      if (!existing) throw new ValidationError('idempotencyKey', 'key state changed concurrently — retry');
      if (existing.operation !== name || existing.requestHash !== requestHash) {
        throw new ValidationError('idempotencyKey', 'key was already used for a different request');
      }
      if (existing.responseJson == null) {
        // Reclaim an orphaned reservation (process died mid-request): the
        // conditional deleteMany is atomic, so of two concurrent retries only
        // one proceeds; the other still sees in-flight.
        const cutoff = new Date(Date.now() - STALE_RESERVATION_MS);
        const reclaimed = await db.idempotencyRecord.deleteMany({
          where: { key: idempotencyKey!, responseJson: null, createdAt: { lt: cutoff } },
        });
        if (reclaimed.count === 1) {
          return runOperation(db, provider, name, input, idempotencyKey);
        }
        throw new ValidationError('idempotencyKey', 'a request with this key is still in flight — retry shortly');
      }
      return { result: JSON.parse(existing.responseJson), replayed: true };
    }
  }

  let result: unknown;
  try {
    result = await op.run(db, provider, input);
  } catch (err) {
    // Release the reservation so the caller's retry can execute.
    if (useIdempotency) {
      await db.idempotencyRecord.delete({ where: { key: idempotencyKey! } }).catch(() => {});
    }
    throw toCalendarToolError(err);
  }

  if (useIdempotency) {
    // The mutation already SUCCEEDED; persist its response so a retry replays
    // instead of re-executing. A silent failure here is dangerous: the
    // reservation stays in-flight and, past the staleness cutoff, a retry
    // reclaims it and re-runs the mutation (duplicate event/invite email). We
    // cannot throw — that would tell the caller the (completed) op failed and
    // invite exactly that retry — so surface it loudly instead.
    await db.idempotencyRecord
      .update({ where: { key: idempotencyKey! }, data: { responseJson: JSON.stringify(result) } })
      .catch((err) =>
        logError(
          `idempotency completion write failed for key ${idempotencyKey} (${name}) — the mutation succeeded but is not recorded; a retry after the ${STALE_RESERVATION_MS}ms staleness window could re-execute it`,
          err,
        ),
      );
  }
  return { result, replayed: false };
}
