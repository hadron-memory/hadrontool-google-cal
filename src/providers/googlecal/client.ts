/**
 * Production GoogleCalProvider — plain REST over fetch (no SDK; the surface
 * this tool needs is small and the error mapping stays fully in our hands).
 *
 * All calls use delegated scopes (the tool acts as the signed-in user),
 * acquire an access token from the connection's refresh token per call
 * (cached until near expiry), and surface refresh-token rotation via
 * CalendarCallResult (Google normally doesn't rotate, but the plumbing is
 * the platform-wide invariant — see findings:oauth-rotation-persist-on-failure).
 */
import { retryAfterSeconds, ValidationError } from '../../errors.js';
import { refreshAccessToken, exchangeGoogleCode, fetchGoogleProfile } from './auth.js';
import type {
  CalendarCallResult,
  EventInput,
  EventPatch,
  GoogleAttendee,
  GoogleCalendar,
  GoogleCalEvent,
  GoogleCalProvider,
  GoogleEventTime,
  GoogleResponseStatus,
  ListEventsOptions,
  ScheduleBusy,
} from './types.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
const REQUEST_TIMEOUT_MS = 30000;
/** Inline 429 retry budget: beyond this the typed provider_rate_limited
 *  propagates — the caller (hadron-server) times out around 30s, so sleeping
 *  longer here would answer nobody and can double mutations. */
const MAX_INLINE_RETRY_AFTER_S = 10;

/** Shape of a failed Google API call — what mapGoogleError consumes. */
interface ApiError extends Error {
  statusCode: number;
  reason?: string;
  headers: Headers;
}

/**
 * Fetch a Google API endpoint with a bearer token. The timeout signal covers
 * the response BODY read, not just the headers. A 429 with a small
 * Retry-After is retried ONCE at this per-request level (never re-running a
 * whole multi-call operation). Failures throw an ApiError carrying status +
 * Google's error reason for the typed mapper.
 */
async function apiFetch<T>(
  accessToken: string,
  method: string,
  path: string,
  options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  attempt = 0,
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal,
  });
  const text = await res.text(); // still under the same timeout signal
  if (!res.ok) {
    if (res.status === 429 && attempt === 0) {
      const wait = retryAfterSeconds(res.headers, 5);
      if (wait <= MAX_INLINE_RETRY_AFTER_S) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return apiFetch(accessToken, method, path, options, attempt + 1);
      }
    }
    let reason: string | undefined;
    let message = `Google Calendar API ${method} ${path} failed with ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
      reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    const err = new Error(message) as ApiError;
    err.statusCode = res.status;
    err.reason = reason;
    err.headers = res.headers;
    throw err;
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Cached access tokens keyed by refresh token — Google access tokens live
 *  ~1h; refreshing per provider call would cost one token-endpoint POST per
 *  operation. Entries expire with a safety margin. */
const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
const TOKEN_EXPIRY_MARGIN_S = 120;
const TOKEN_CACHE_MAX = 1000;

/**
 * Execute a Google call using a refresh token: acquire an access token
 * (cached across calls until near expiry) and report refresh-token rotation.
 * Failures propagate for mapGoogleError at the ops layer; per-request 429
 * handling lives in apiFetch.
 */
async function withToken<T>(
  refreshToken: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<CalendarCallResult<T>> {
  const cached = accessTokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now()) {
    return { data: await fn(cached.accessToken) };
  }

  const tokenRes = await refreshAccessToken(refreshToken);
  const accessToken = tokenRes.access_token;
  const newRefreshToken =
    tokenRes.refresh_token && tokenRes.refresh_token !== refreshToken ? tokenRes.refresh_token : undefined;
  if (accessTokenCache.size >= TOKEN_CACHE_MAX) accessTokenCache.clear();
  accessTokenCache.set(newRefreshToken ?? refreshToken, {
    accessToken,
    expiresAt: Date.now() + Math.max(0, (tokenRes.expires_in ?? 0) - TOKEN_EXPIRY_MARGIN_S) * 1000,
  });

  try {
    const data = await fn(accessToken);
    return { data, newRefreshToken };
  } catch (err) {
    // The refresh SUCCEEDED before fn() failed — a rotated token must still
    // reach the caller or one harmless API error permanently strands the
    // connection. withConnection persists it from the error object.
    if (newRefreshToken && err != null && typeof err === 'object') {
      (err as { newRefreshToken?: string }).newRefreshToken = newRefreshToken;
    }
    throw err;
  }
}

// ── API resource shapes (the subset this tool reads) ─────────────────────

interface CalendarListResponse {
  items?: {
    id: string;
    summary?: string;
    summaryOverride?: string;
    description?: string;
    timeZone?: string;
    primary?: boolean;
    accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
  }[];
  nextPageToken?: string;
}

interface EventResource {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: {
    email?: string;
    displayName?: string;
    optional?: boolean;
    responseStatus?: string;
    self?: boolean;
    resource?: boolean;
  }[];
  htmlLink?: string;
  recurringEventId?: string;
  created?: string;
  updated?: string;
}

interface EventListResponse {
  items?: EventResource[];
  nextPageToken?: string;
}

interface FreeBusyResponse {
  calendars?: Record<
    string,
    { busy?: { start: string; end: string }[]; errors?: { domain?: string; reason?: string }[] }
  >;
}

/** Parse an event boundary; Google may omit one representation entirely. */
function parseTime(t: { dateTime?: string; date?: string; timeZone?: string } | undefined): GoogleEventTime {
  return {
    dateTime: t?.dateTime ?? null,
    date: t?.date ?? null,
    timeZone: t?.timeZone ?? null,
  };
}

const RESPONSE_STATUSES: GoogleResponseStatus[] = ['needsAction', 'declined', 'tentative', 'accepted'];

/** Parse an attendee list; entries without an email are dropped. */
function parseAttendees(attendees: EventResource['attendees']): GoogleAttendee[] {
  return (attendees ?? [])
    .filter((a): a is typeof a & { email: string } => Boolean(a.email))
    .map((a) => ({
      email: a.email,
      displayName: a.displayName ?? null,
      optional: a.optional ?? false,
      responseStatus: RESPONSE_STATUSES.includes(a.responseStatus as GoogleResponseStatus)
        ? (a.responseStatus as GoogleResponseStatus)
        : 'needsAction',
      self: a.self ?? false,
      resource: a.resource ?? false,
    }));
}

/** Parse an event resource into the provider shape. */
export function parseEvent(calendarId: string, e: EventResource): GoogleCalEvent {
  return {
    id: e.id,
    calendarId,
    status: e.status === 'tentative' || e.status === 'cancelled' ? e.status : 'confirmed',
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    start: parseTime(e.start),
    end: parseTime(e.end),
    organizer: e.organizer
      ? { email: e.organizer.email ?? null, displayName: e.organizer.displayName ?? null, self: e.organizer.self ?? false }
      : null,
    attendees: parseAttendees(e.attendees),
    htmlLink: e.htmlLink ?? null,
    recurringEventId: e.recurringEventId ?? null,
    created: e.created ?? null,
    updated: e.updated ?? null,
  };
}

/** Build the Google event body from the neutral input/patch shape. */
function toEventBody(input: EventInput | EventPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.summary = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined) body.start = input.start;
  if (input.end !== undefined) body.end = input.end;
  if (input.attendees !== undefined) body.attendees = input.attendees.map((email) => ({ email }));
  return body;
}

/** URL-encode a calendar/event id path segment. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

export const googleCalProvider: GoogleCalProvider = {
  exchangeCode: exchangeGoogleCode,
  fetchProfile: fetchGoogleProfile,

  async listCalendars(refreshToken) {
    return withToken(refreshToken, async (accessToken) => {
      const calendars: GoogleCalendar[] = [];
      let pageToken: string | undefined;
      do {
        const page = await apiFetch<CalendarListResponse>(accessToken, 'GET', '/users/me/calendarList', {
          query: { maxResults: 250, pageToken },
        });
        for (const item of page.items ?? []) {
          calendars.push({
            id: item.id,
            // summaryOverride is the user's own rename of a shared calendar.
            name: item.summaryOverride ?? item.summary ?? item.id,
            description: item.description ?? null,
            timeZone: item.timeZone ?? null,
            isPrimary: item.primary ?? false,
            canEdit: item.accessRole === 'owner' || item.accessRole === 'writer',
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return calendars;
    });
  },

  async listEvents(refreshToken, calendarId, options: ListEventsOptions = {}) {
    return withToken(refreshToken, async (accessToken) => {
      const top = options.top ?? 25;
      const events: GoogleCalEvent[] = [];
      let pageToken: string | undefined;
      do {
        const page = await apiFetch<EventListResponse>(accessToken, 'GET', `/calendars/${seg(calendarId)}/events`, {
          query: {
            maxResults: Math.min(top - events.length, 250),
            // Recurring events expand to instances so time filters and
            // chronological ordering behave the way a schedule reads.
            singleEvents: true,
            orderBy: 'startTime',
            timeMin: options.start,
            timeMax: options.end,
            q: options.query,
            pageToken,
          },
        });
        events.push(...(page.items ?? []).map((e) => parseEvent(calendarId, e)));
        pageToken = page.nextPageToken;
      } while (pageToken && events.length < top);
      return events.slice(0, top);
    });
  },

  async getEvent(refreshToken, calendarId, eventId) {
    return withToken(refreshToken, async (accessToken) => {
      const e = await apiFetch<EventResource>(accessToken, 'GET', `/calendars/${seg(calendarId)}/events/${seg(eventId)}`);
      return parseEvent(calendarId, e);
    });
  },

  async createEvent(refreshToken, calendarId, input, notify) {
    return withToken(refreshToken, async (accessToken) => {
      const e = await apiFetch<EventResource>(accessToken, 'POST', `/calendars/${seg(calendarId)}/events`, {
        query: { sendUpdates: notify },
        body: toEventBody(input),
      });
      return parseEvent(calendarId, e);
    });
  },

  async updateEvent(refreshToken, calendarId, eventId, patch, notify) {
    return withToken(refreshToken, async (accessToken) => {
      const e = await apiFetch<EventResource>(accessToken, 'PATCH', `/calendars/${seg(calendarId)}/events/${seg(eventId)}`, {
        query: { sendUpdates: notify },
        body: toEventBody(patch),
      });
      return parseEvent(calendarId, e);
    });
  },

  async deleteEvent(refreshToken, calendarId, eventId, notify) {
    return withToken(refreshToken, async (accessToken) => {
      await apiFetch<undefined>(accessToken, 'DELETE', `/calendars/${seg(calendarId)}/events/${seg(eventId)}`, {
        query: { sendUpdates: notify },
      });
    });
  },

  async respondToEvent(refreshToken, calendarId, eventId, response) {
    return withToken(refreshToken, async (accessToken) => {
      // Google has no one-call RSVP: the response is the connected account's
      // OWN attendee entry's responseStatus, updated via events.patch. The
      // self flag identifies that entry (never email matching — aliases and
      // group invitations break it). Patching `attendees` replaces the whole
      // list, so the full set is sent back with only self's status changed.
      const original = await apiFetch<EventResource>(
        accessToken,
        'GET',
        `/calendars/${seg(calendarId)}/events/${seg(eventId)}`,
      );
      const attendees = original.attendees ?? [];
      if (!attendees.some((a) => a.self)) {
        throw new ValidationError('eventId', 'the connected account is not an attendee of this event');
      }
      const e = await apiFetch<EventResource>(accessToken, 'PATCH', `/calendars/${seg(calendarId)}/events/${seg(eventId)}`, {
        body: {
          attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: response } : a)),
        },
      });
      return parseEvent(calendarId, e);
    });
  },

  async querySchedule(refreshToken, start, end, scheduleIds) {
    return withToken(refreshToken, async (accessToken) => {
      const res = await apiFetch<FreeBusyResponse>(accessToken, 'POST', '/freeBusy', {
        body: { timeMin: start, timeMax: end, items: scheduleIds.map((id) => ({ id })) },
      });
      // Answer in request order; a schedule Google couldn't resolve keeps its
      // slot with an error marker instead of failing the whole query.
      return scheduleIds.map((id): ScheduleBusy => {
        const entry = res.calendars?.[id];
        if (!entry) return { id, busy: [], error: 'not_found' };
        const providerError = entry.errors?.[0]?.reason ?? null;
        return { id, busy: entry.busy ?? [], error: providerError };
      });
    });
  },
};
