/**
 * Test doubles: an in-memory GoogleCalProvider fake with call recording, and
 * a fixture GoogleCalEvent builder. Route tests run the real Express app +
 * real test DB over these fakes — only Google is simulated.
 */
import type { Db } from '../db.js';
import type {
  CalendarCallResult,
  GoogleCalEvent,
  GoogleCalProvider,
} from '../providers/googlecal/types.js';

/** Wipe every table in FK-safe order — the one cleanup list all test files share. */
export async function resetDb(db: Db): Promise<void> {
  await db.idempotencyRecord.deleteMany();
  await db.connection.deleteMany();
}

/** Build a plausible parsed Google Calendar event fixture. */
export function googleCalEvent(overrides: Partial<GoogleCalEvent> = {}): GoogleCalEvent {
  return {
    id: 'evt-1',
    calendarId: 'primary',
    status: 'confirmed',
    summary: 'Mentoring session',
    description: 'Monthly check-in',
    location: 'Meet',
    start: { dateTime: '2026-07-15T10:00:00-07:00', date: null, timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-07-15T10:30:00-07:00', date: null, timeZone: 'America/Los_Angeles' },
    organizer: { email: 'mentor@example.org', displayName: 'The Mentor', self: false },
    attendees: [
      { email: 'mentor@example.org', displayName: 'The Mentor', optional: false, responseStatus: 'accepted', self: false, resource: false },
      { email: 'user@gcal.example', displayName: 'Cal User', optional: false, responseStatus: 'needsAction', self: true, resource: false },
    ],
    htmlLink: 'https://calendar.google.com/event?eid=abc',
    recurringEventId: null,
    created: '2026-07-01T00:00:00.000Z',
    updated: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

/** Wrap data in a CalendarCallResult. */
function ok<T>(data: T, newRefreshToken?: string): CalendarCallResult<T> {
  return { data, newRefreshToken };
}

export interface FakeProviderOptions {
  /** When set, every calendar call reports this rotated refresh token once. */
  rotateTo?: string;
  /** When set, the named methods throw this error. */
  failWith?: { methods: string[]; error: unknown };
  /** Simulate a grant without offline access: exchangeCode omits refresh_token. */
  omitRefreshToken?: boolean;
  /** Simulate an ID token without claims: identity must come from userinfo. */
  omitIdToken?: boolean;
  /** What listEvents / getEvent return. */
  event?: GoogleCalEvent;
}

/**
 * A recording fake provider. `calls` collects [method, args] tuples so tests
 * assert both HTTP behavior and what reached "Google".
 */
export function fakeProvider(options: FakeProviderOptions = {}): GoogleCalProvider & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  let rotation = options.rotateTo;

  /** Record a call; throw if configured to fail; consume one rotation. */
  function record<T>(method: string, args: unknown[], data: T): CalendarCallResult<T> {
    calls.push([method, args]);
    if (options.failWith?.methods.includes(method)) throw options.failWith.error;
    const result = ok(data, rotation);
    rotation = undefined;
    return result;
  }

  const fixture = () => options.event ?? googleCalEvent();

  return {
    calls,
    async exchangeCode(code, redirectUri) {
      calls.push(['exchangeCode', [code, redirectUri]]);
      if (options.failWith?.methods.includes('exchangeCode')) throw options.failWith.error;
      return {
        access_token: 'at-1',
        ...(options.omitRefreshToken ? {} : { refresh_token: 'rt-fresh' }),
        // header.payload.signature — payload carries the OpenID claims
        ...(options.omitIdToken
          ? {}
          : {
              id_token: `x.${Buffer.from(
                JSON.stringify({ email: 'user@gcal.example', name: 'Cal User' }),
              ).toString('base64url')}.y`,
            }),
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
      };
    },
    async fetchProfile() {
      calls.push(['fetchProfile', []]);
      return { email: 'userinfo@gcal.example', name: 'Userinfo User' };
    },
    async listCalendars(token) {
      return record('listCalendars', [token], [
        { id: 'primary', name: 'Cal User', description: null, timeZone: 'America/Los_Angeles', isPrimary: true, canEdit: true },
        { id: 'team@group.calendar.google.com', name: 'Team', description: null, timeZone: 'UTC', isPrimary: false, canEdit: false },
      ]);
    },
    async listEvents(token, calendarId, opts) {
      return record('listEvents', [token, calendarId, opts], [fixture()]);
    },
    async getEvent(token, calendarId, eventId) {
      return record('getEvent', [token, calendarId, eventId], { ...fixture(), id: eventId });
    },
    async createEvent(token, calendarId, input, notify) {
      return record('createEvent', [token, calendarId, input, notify], { ...fixture(), id: 'evt-new' });
    },
    async updateEvent(token, calendarId, eventId, patch, notify) {
      return record('updateEvent', [token, calendarId, eventId, patch, notify], { ...fixture(), id: eventId });
    },
    async deleteEvent(token, calendarId, eventId, notify) {
      return record('deleteEvent', [token, calendarId, eventId, notify], undefined);
    },
    async respondToEvent(token, calendarId, eventId, response) {
      return record('respondToEvent', [token, calendarId, eventId, response], { ...fixture(), id: eventId });
    },
    async querySchedule(token, start, end, scheduleIds) {
      return record(
        'querySchedule',
        [token, start, end, scheduleIds],
        scheduleIds.map((id) => ({
          id,
          busy: [{ start: '2026-07-15T10:00:00Z', end: '2026-07-15T10:30:00Z' }],
          error: null,
        })),
      );
    },
  };
}
