import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { decryptToken, encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

beforeEach(() => resetDb(db));

describe('/connections', () => {
  it('creates a connection from an OAuth code, using ID-token claims first', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/auth/google-cal/callback' });

    expect(res.status).toBe(201);
    // `mailboxEmail` is the shared core identity contract — for this tool it
    // carries the Google account email.
    expect(res.body).toMatchObject({
      provider: 'google-cal',
      mailboxEmail: 'user@gcal.example',
      displayName: 'Cal User',
      status: 'ACTIVE',
    });
    // The exchange used core's redirect URI (must match the authorize URL).
    expect(provider.calls[0]).toEqual(['exchangeCode', ['auth-code-1', 'https://core.example/auth/google-cal/callback']]);
    // ID-token claims sufficed — no userinfo round-trip.
    expect(provider.calls.some(([m]) => m === 'fetchProfile')).toBe(false);

    // The refresh token is stored ENCRYPTED, decryptable with the tool key.
    const row = await db.connection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.refreshTokenEnc).not.toContain('rt-fresh');
    expect(decryptToken(row.refreshTokenEnc)).toBe('rt-fresh');
  });

  it('falls back to the userinfo endpoint when the ID token lacks claims', async () => {
    const provider = fakeProvider({ omitIdToken: true });
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/cb' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mailboxEmail: 'userinfo@gcal.example', displayName: 'Userinfo User' });
    expect(provider.calls.some(([m]) => m === 'fetchProfile')).toBe(true);
  });

  it('returns a typed error when Google omits the refresh token (offline access not granted)', async () => {
    const app = createApp(db, fakeProvider({ omitRefreshToken: true }));
    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ code: 'auth-code-1', redirectUri: 'https://core.example/cb' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.reason).toContain('access_type=offline');
    expect(await db.connection.count()).toBe(0);
  });

  it('rejects a create without a code', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/connections').set(AUTH).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects calls without the bearer token', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/connections').send({ code: 'c', redirectUri: 'r' });
    expect(res.status).toBe(401);
  });

  it('returns the identity on GET, and 404s a deleted connection', async () => {
    const connection = await db.connection.create({
      data: { accountEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app = createApp(db, fakeProvider());

    const res = await request(app).get(`/connections/${connection.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mailboxEmail: 'a@b.c', status: 'ACTIVE', lastError: null });
    // The encrypted token never leaves the tool.
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');

    await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
    await request(app).get(`/connections/${connection.id}`).set(AUTH).expect(404);
  });

  it('soft-deletes a connection and 404s a repeat delete', async () => {
    const connection = await db.connection.create({
      data: { accountEmail: 'a@b.c', refreshTokenEnc: encryptToken('rt') },
    });
    const app = createApp(db, fakeProvider());

    await request(app).delete(`/connections/${connection.id}`).set(AUTH).expect(200);
    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.deletedAt).not.toBeNull();

    await request(app).delete(`/connections/${connection.id}`).set(AUTH).expect(404);
  });
});
