/**
 * Provider-layer types + the injectable GoogleCalProvider interface.
 *
 * The ops layer (src/ops) and routes depend only on this interface; tests
 * inject a fake, and src/providers/googlecal/client.ts is the production
 * implementation over the Google Calendar REST API (v3).
 *
 * The provider returns lightly-parsed Google shapes (GoogleCalEvent etc.);
 * the ops layer owns the final provider-neutral normalization, mirroring the
 * hadrontool-gmail split.
 */

export interface TokenResponse {
  access_token: string;
  /** Google returns this only when the authorize URL carried
   *  `access_type=offline&prompt=consent`; refresh responses normally omit it. */
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Identity from the ID token / OpenID userinfo endpoint. */
export interface GoogleProfile {
  email: string | null;
  name: string | null;
}

/** A Google Calendar list entry. */
export interface GoogleCalendar {
  id: string;
  name: string;
  description: string | null;
  timeZone: string | null;
  isPrimary: boolean;
  /** True when the connected account may create/modify events here
   *  (accessRole `owner` or `writer`). */
  canEdit: boolean;
}

/** An event boundary: exactly one of dateTime (timed) or date (all-day). */
export interface GoogleEventTime {
  dateTime: string | null;
  date: string | null;
  timeZone: string | null;
}

/** Google's attendee responseStatus vocabulary. */
export type GoogleResponseStatus = 'needsAction' | 'declined' | 'tentative' | 'accepted';

export interface GoogleAttendee {
  email: string;
  displayName: string | null;
  optional: boolean;
  responseStatus: GoogleResponseStatus;
  /** True on the attendee entry that IS the connected account (Google sets
   *  this on the authenticated user's copy of the event). */
  self: boolean;
  /** True when the "attendee" is a room/resource, not a person. */
  resource: boolean;
}

/** A Google Calendar event, lightly parsed. */
export interface GoogleCalEvent {
  id: string;
  calendarId: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string | null;
  description: string | null;
  location: string | null;
  start: GoogleEventTime;
  end: GoogleEventTime;
  organizer: { email: string | null; displayName: string | null; self: boolean } | null;
  attendees: GoogleAttendee[];
  htmlLink: string | null;
  /** Series id when this is an instance of a recurring event. */
  recurringEventId: string | null;
  created: string | null;
  updated: string | null;
}

export interface ListEventsOptions {
  /** RFC 3339 lower bound (inclusive) on event end time. */
  start?: string;
  /** RFC 3339 upper bound (exclusive) on event start time. */
  end?: string;
  /** Free-text search over event fields. */
  query?: string;
  top?: number;
}

/** Fields for creating an event. `start`/`end` carry exactly one of
 *  dateTime/date (validated at the ops layer). */
export interface EventInput {
  title: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: string[];
}

/** Fields for patching an event; every field optional, absent = unchanged. */
export interface EventPatch {
  title?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: string[];
}

/** Whether the provider should email attendees about a mutation
 *  (Google `sendUpdates`; the neutral input is a boolean). */
export type NotifyAttendees = 'all' | 'none';

/** One schedule's busy intervals from a free/busy query. */
export interface ScheduleBusy {
  id: string;
  busy: { start: string; end: string }[];
  /** Set when the provider could not resolve this schedule (e.g. a calendar
   *  the account cannot read) — the query still succeeds for the others. */
  error: string | null;
}

/**
 * Result of a token-refreshing Google call. Google normally does NOT rotate
 * refresh tokens, but the plumbing is kept (per the platform-wide
 * oauth-rotation-persist-on-failure finding): if a rotated token ever
 * appears, `newRefreshToken` is set and the caller MUST persist it.
 */
export interface CalendarCallResult<T> {
  data: T;
  newRefreshToken?: string;
}

/**
 * Everything the tool needs from Google. One method per interaction; every
 * calendar method takes the connection's refresh token and reports rotation
 * via CalendarCallResult.
 */
export interface GoogleCalProvider {
  // ── OAuth ────────────────────────────────────────────────────────────
  exchangeCode(code: string, redirectUri: string): Promise<TokenResponse>;
  fetchProfile(accessToken: string): Promise<GoogleProfile>;

  // ── Calendar operations (delegated — acts as the signed-in user) ─────
  listCalendars(refreshToken: string): Promise<CalendarCallResult<GoogleCalendar[]>>;
  listEvents(refreshToken: string, calendarId: string, options?: ListEventsOptions): Promise<CalendarCallResult<GoogleCalEvent[]>>;
  getEvent(refreshToken: string, calendarId: string, eventId: string): Promise<CalendarCallResult<GoogleCalEvent>>;
  createEvent(refreshToken: string, calendarId: string, input: EventInput, notify: NotifyAttendees): Promise<CalendarCallResult<GoogleCalEvent>>;
  updateEvent(refreshToken: string, calendarId: string, eventId: string, patch: EventPatch, notify: NotifyAttendees): Promise<CalendarCallResult<GoogleCalEvent>>;
  deleteEvent(refreshToken: string, calendarId: string, eventId: string, notify: NotifyAttendees): Promise<CalendarCallResult<void>>;
  /** Set the connected account's OWN responseStatus on an event it was
   *  invited to (get → patch of the self attendee). */
  respondToEvent(refreshToken: string, calendarId: string, eventId: string, response: GoogleResponseStatus): Promise<CalendarCallResult<GoogleCalEvent>>;
  /** Free/busy intervals for the given schedule ids (calendar ids or
   *  addresses the account can read). */
  querySchedule(refreshToken: string, start: string, end: string, scheduleIds: string[]): Promise<CalendarCallResult<ScheduleBusy[]>>;
}
