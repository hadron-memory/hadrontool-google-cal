import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { db } from '../db.js';
import { hashInput } from '../ops/index.js';
import { fakeProvider, googleCalEvent, resetDb } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

/** Seed one ACTIVE connection and return its id. */
async function seedConnection(refreshToken = 'rt-original'): Promise<string> {
  const row = await db.connection.create({
    data: { accountEmail: 'user@gcal.example', refreshTokenEnc: encryptToken(refreshToken) },
  });
  return row.id;
}

/** A timed event window used by mutation tests. */
const WINDOW = {
  start: { dateTime: '2026-07-20T09:00:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-07-20T09:30:00', timeZone: 'America/Los_Angeles' },
};

beforeEach(() => resetDb(db));

describe('POST /ops/:operation', () => {
  it('rejects calls without the bearer token', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/list-events').send({ connectionId: 'c' });
    expect(res.status).toBe(401);
  });

  it('404s an unknown operation, listing the known ones', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/read-minds').set(AUTH).send({});
    expect(res.status).toBe(404);
    expect(res.body.operations).toContain('list-events');
  });

  it('returns connection_not_found for an unknown connectionId', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/list-events').set(AUTH).send({ connectionId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_not_found');
  });

  it('lists events in the neutral shape, decrypting the stored token', async () => {
    const connectionId = await seedConnection('rt-original');
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/ops/list-events')
      .set(AUTH)
      .send({ connectionId, start: '2026-07-14T00:00:00Z', end: '2026-07-21T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      id: 'evt-1',
      calendarId: 'primary',
      title: 'Mentoring session',
      isAllDay: false,
      isOrganizer: false,
      myResponse: 'none', // derived from the self attendee's needsAction
      organizer: { address: 'mentor@example.org' },
    });
    // The DECRYPTED token reached the provider, defaulting to the primary
    // calendar, with the window intact.
    const [method, args] = provider.calls[0];
    expect(method).toBe('listEvents');
    expect(args[0]).toBe('rt-original');
    expect(args[1]).toBe('primary');
    expect(args[2]).toMatchObject({ start: '2026-07-14T00:00:00Z', end: '2026-07-21T00:00:00Z' });
  });

  it('normalizes an all-day event and filters resource attendees', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider({
      event: googleCalEvent({
        start: { dateTime: null, date: '2026-07-20', timeZone: null },
        end: { dateTime: null, date: '2026-07-21', timeZone: null },
        attendees: [
          { email: 'user@gcal.example', displayName: 'Cal User', optional: false, responseStatus: 'accepted', self: true, resource: false },
          { email: 'room-3@resource.calendar.google.com', displayName: 'Room 3', optional: false, responseStatus: 'accepted', self: false, resource: true },
        ],
      }),
    });
    const app = createApp(db, provider);

    const res = await request(app).post('/ops/get-event').set(AUTH).send({ connectionId, eventId: 'evt-1' });
    expect(res.status).toBe(200);
    expect(res.body.event.isAllDay).toBe(true);
    expect(res.body.event.myResponse).toBe('accepted');
    expect(res.body.event.attendees).toHaveLength(1); // the room is filtered out
  });

  it('lists calendars', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/list-calendars').set(AUTH).send({ connectionId });
    expect(res.status).toBe(200);
    expect(res.body.calendars).toHaveLength(2);
    expect(res.body.calendars[0]).toMatchObject({ id: 'primary', isPrimary: true, canEdit: true });
  });

  it('persists a rotated refresh token', async () => {
    const connectionId = await seedConnection('rt-original');
    const app = createApp(db, fakeProvider({ rotateTo: 'rt-rotated' }));

    await request(app).post('/ops/get-event').set(AUTH).send({ connectionId, eventId: 'e-1' }).expect(200);

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-rotated');
  });

  it('creates an event, mapping notifyAttendees onto sendUpdates', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({ connectionId, title: 'Standup', ...WINDOW, attendees: ['peer@example.org'], notifyAttendees: false });
    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe('evt-new');

    const [method, args] = provider.calls[0];
    expect(method).toBe('createEvent');
    expect(args[1]).toBe('primary');
    expect(args[2]).toMatchObject({ title: 'Standup', attendees: ['peer@example.org'] });
    expect(args[3]).toBe('none'); // notifyAttendees: false
  });

  it('rejects an event boundary carrying BOTH dateTime and date', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({
        connectionId,
        title: 'Broken',
        start: { dateTime: '2026-07-20T09:00:00Z', date: '2026-07-20' },
        end: WINDOW.end,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(provider.calls.filter(([m]) => m === 'createEvent')).toHaveLength(0);
  });

  it('rejects a zone-less dateTime without a timeZone', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());

    const res = await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({
        connectionId,
        title: 'Ambiguous',
        start: { dateTime: '2026-07-20T09:00:00' },
        end: { dateTime: '2026-07-20T09:30:00' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('accepts an offset-carrying dateTime without a timeZone', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());

    const res = await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({
        connectionId,
        title: 'Zoned',
        start: { dateTime: '2026-07-20T09:00:00-07:00' },
        end: { dateTime: '2026-07-20T09:30:00-07:00' },
      });
    expect(res.status).toBe(200);
  });

  describe.each(['start', 'end'] as const)('update-event %s boundary', (field) => {
    it.each([
      ['a zone-less dateTime without a timeZone', { dateTime: '2026-07-20T09:00:00' }, 'timeZone'],
      ['an all-day date not shaped YYYY-MM-DD', { date: '20/07/2026' }, 'YYYY-MM-DD'],
      ['neither dateTime nor date', { timeZone: 'America/Los_Angeles' }, 'exactly one'],
      ['both dateTime and date', { dateTime: '2026-07-20T09:00:00Z', date: '2026-07-20' }, 'exactly one'],
    ])('rejects %s, naming the field and rule, with no provider call at all', async (_label, boundary, reason) => {
      const connectionId = await seedConnection();
      const provider = fakeProvider();
      const app = createApp(db, provider);

      const res = await request(app)
        .post('/ops/update-event')
        .set(AUTH)
        .send({ connectionId, eventId: 'evt-1', [field]: boundary });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.field).toContain(field);
      expect(res.body.reason).toContain(reason);
      expect(provider.calls).toHaveLength(0);
    });
  });

  it('update-event accepts valid start and end boundaries and forwards them to the provider', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/ops/update-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'evt-1', start: WINDOW.start, end: WINDOW.end });
    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe('evt-1');

    const update = provider.calls.find(([m]) => m === 'updateEvent');
    expect(update).toBeDefined();
    const [, [, , eventId, patch]] = update!;
    expect(eventId).toBe('evt-1');
    expect(patch).toMatchObject({ start: WINDOW.start, end: WINDOW.end });
  });

  it('update-event accepts an offset-carrying dateTime and an all-day date', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());

    await request(app)
      .post('/ops/update-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'evt-1', start: { dateTime: '2026-07-20T09:00:00-07:00' } })
      .expect(200);
    await request(app)
      .post('/ops/update-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'evt-1', start: { date: '2026-07-20' }, end: { date: '2026-07-21' } })
      .expect(200);
  });

  it('responds to an invitation with the neutral vocabulary', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/ops/respond-to-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'evt-1', response: 'accepted' });
    expect(res.status).toBe(200);
    const [method, args] = provider.calls[0];
    expect(method).toBe('respondToEvent');
    expect(args[3]).toBe('accepted');
  });

  it('queries free/busy schedules, defaulting to primary', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/ops/get-schedule')
      .set(AUTH)
      .send({ connectionId, start: '2026-07-15T00:00:00Z', end: '2026-07-16T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toEqual([
      { id: 'primary', busy: [{ start: '2026-07-15T10:00:00Z', end: '2026-07-15T10:30:00Z' }], error: null },
    ]);
    const [, args] = provider.calls[0];
    expect(args[3]).toEqual(['primary']);
  });

  it('replays a mutating operation with the same idempotencyKey without touching the provider', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const body = { connectionId, title: 'Once', ...WINDOW, idempotencyKey: 'key-1' };
    const first = await request(app).post('/ops/create-event').set(AUTH).send(body);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);

    const second = await request(app).post('/ops/create-event').set(AUTH).send(body);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.event.id).toBe('evt-new');

    expect(provider.calls.filter(([m]) => m === 'createEvent')).toHaveLength(1);
  });

  it('rejects reusing an idempotencyKey across operations', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());

    await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({ connectionId, title: 'A', ...WINDOW, idempotencyKey: 'shared' })
      .expect(200);
    const res = await request(app)
      .post('/ops/delete-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'evt-1', idempotencyKey: 'shared' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects an idempotencyKey replayed with a different payload', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());

    await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({ connectionId, title: 'A', ...WINDOW, idempotencyKey: 'key-p' })
      .expect(200);
    const res = await request(app)
      .post('/ops/create-event')
      .set(AUTH)
      .send({ connectionId, title: 'B — different!', ...WINDOW, idempotencyKey: 'key-p' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects a key whose original request is still in flight (no double execution)', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    // Simulate an in-flight original: a reservation row with no response yet.
    await db.idempotencyRecord.create({
      data: { key: 'key-inflight', operation: 'delete-event', requestHash: 'someone-elses-hash', responseJson: null },
    });
    const res = await request(app)
      .post('/ops/delete-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'e-1', idempotencyKey: 'key-inflight' });
    expect(res.status).toBe(400);
    expect(provider.calls.filter(([m]) => m === 'deleteEvent')).toHaveLength(0);
  });

  it('reclaims a stale orphaned reservation (crashed process) so a retry executes', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider();
    const app = createApp(db, provider);

    // A reservation from a request whose process died mid-flight, past the
    // staleness cutoff — the retry (same payload, same hash) must execute.
    await db.idempotencyRecord.create({
      data: {
        key: 'key-orphan',
        operation: 'delete-event',
        // The hash covers the RAW input (defaults are applied later, at parse).
        requestHash: hashInput({ connectionId, eventId: 'e-1' }),
        responseJson: null,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    const res = await request(app)
      .post('/ops/delete-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'e-1', idempotencyKey: 'key-orphan' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, replayed: false });
    expect(provider.calls.filter(([m]) => m === 'deleteEvent')).toHaveLength(1);
  });

  it('releases the reservation when the operation fails so a retry can execute', async () => {
    const connectionId = await seedConnection();
    const failing = createApp(db, fakeProvider({ failWith: { methods: ['deleteEvent'], error: { statusCode: 503 } } }));
    await request(failing)
      .post('/ops/delete-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'e-1', idempotencyKey: 'key-retry' })
      .expect(502);

    const working = createApp(db, fakeProvider());
    const res = await request(working)
      .post('/ops/delete-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'e-1', idempotencyKey: 'key-retry' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, replayed: false });
  });

  it('persists a rotated refresh token even when the API call fails', async () => {
    const connectionId = await seedConnection('rt-original');
    // The real client attaches newRefreshToken to the thrown error when the
    // refresh succeeded before the API call failed — the fake simulates that.
    const app = createApp(
      db,
      fakeProvider({ failWith: { methods: ['getEvent'], error: { statusCode: 404, newRefreshToken: 'rt-rotated-on-failure' } } }),
    );

    const res = await request(app).post('/ops/get-event').set(AUTH).send({ connectionId, eventId: 'gone' });
    expect(res.status).toBe(404);

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-rotated-on-failure');
  });

  it('maps provider auth failure to connection_unauthorized and marks the connection ERROR', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider({ failWith: { methods: ['getEvent'], error: { statusCode: 401 } } }));

    const res = await request(app).post('/ops/get-event').set(AUTH).send({ connectionId, eventId: 'e-1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('connection_unauthorized');

    const row = await db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.status).toBe('ERROR');

    // Subsequent calls short-circuit on the stored ERROR status.
    const again = await request(app).post('/ops/list-events').set(AUTH).send({ connectionId });
    expect(again.status).toBe(403);
  });

  it('surfaces provider rate limiting as provider_rate_limited (Google 403 quota flavor)', async () => {
    const connectionId = await seedConnection();
    const app = createApp(
      db,
      fakeProvider({ failWith: { methods: ['listEvents'], error: { statusCode: 403, reason: 'rateLimitExceeded' } } }),
    );
    const res = await request(app).post('/ops/list-events').set(AUTH).send({ connectionId });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'provider_rate_limited', retryAfterSeconds: 60 });
  });

  it('maps a cancelled event (410 Gone) to not_found', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider({ failWith: { methods: ['getEvent'], error: { statusCode: 410 } } }));
    const res = await request(app).post('/ops/get-event').set(AUTH).send({ connectionId, eventId: 'cancelled' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found', resource: 'event', id: 'cancelled' });
  });

  it('validates input via zod → validation_error', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/list-events').set(AUTH).send({ connectionId, top: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('top');
  });

  it('rejects an invalid response vocabulary value', async () => {
    const connectionId = await seedConnection();
    const app = createApp(db, fakeProvider());
    const res = await request(app)
      .post('/ops/respond-to-event')
      .set(AUTH)
      .send({ connectionId, eventId: 'e-1', response: 'maybe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('response');
  });
});
