import { describe, expect, it } from 'vitest';
import {
  ConnectionUnauthorizedError,
  NotFoundError,
  ProviderRateLimitedError,
  ProviderUnavailableError,
  ValidationError,
  mapGoogleError,
} from './errors.js';

/** Build a Headers-like object with a Retry-After value. */
function headersWith(retryAfter: string | null) {
  return { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) };
}

describe('mapGoogleError', () => {
  it('passes an already-typed error through', () => {
    const typed = new ValidationError('x', 'y');
    expect(mapGoogleError(typed)).toBe(typed);
  });

  it('maps 401 to connection_unauthorized', () => {
    expect(mapGoogleError({ statusCode: 401 })).toBeInstanceOf(ConnectionUnauthorizedError);
  });

  it('maps auth-class 403 reasons to connection_unauthorized', () => {
    for (const reason of ['authError', 'insufficientPermissions', 'accountDisabled']) {
      expect(mapGoogleError({ statusCode: 403, reason }), reason).toBeInstanceOf(ConnectionUnauthorizedError);
    }
  });

  it('maps non-auth 403s (e.g. a per-calendar ACL denial) to provider_unavailable — never bricking the connection', () => {
    expect(mapGoogleError({ statusCode: 403, reason: 'forbidden' })).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGoogleError({ statusCode: 403 })).toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps 403 quota reasons to provider_rate_limited (Google rate limits via 403 too)', () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']) {
      const mapped = mapGoogleError({ statusCode: 403, reason });
      expect(mapped, reason).toBeInstanceOf(ProviderRateLimitedError);
    }
  });

  it('maps 429 to provider_rate_limited, honoring Retry-After', () => {
    const mapped = mapGoogleError({ statusCode: 429, headers: headersWith('17') }) as ProviderRateLimitedError;
    expect(mapped).toBeInstanceOf(ProviderRateLimitedError);
    expect(mapped.retryAfterSeconds).toBe(17);
  });

  it('defaults Retry-After to 60 when absent or malformed', () => {
    const absent = mapGoogleError({ statusCode: 429 }) as ProviderRateLimitedError;
    expect(absent.retryAfterSeconds).toBe(60);
    const malformed = mapGoogleError({ statusCode: 429, headers: headersWith('soon') }) as ProviderRateLimitedError;
    expect(malformed.retryAfterSeconds).toBe(60);
  });

  it('parses the RFC 7231 HTTP-date form of Retry-After', () => {
    const date = new Date(Date.now() + 90 * 1000).toUTCString();
    const mapped = mapGoogleError({ statusCode: 429, headers: headersWith(date) }) as ProviderRateLimitedError;
    expect(mapped.retryAfterSeconds).toBeGreaterThan(80);
    expect(mapped.retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it('maps 404 to not_found with the resource hint', () => {
    const mapped = mapGoogleError({ statusCode: 404 }, { resource: 'calendar', id: 'cal-9' }) as NotFoundError;
    expect(mapped).toBeInstanceOf(NotFoundError);
    expect(mapped.resource).toBe('calendar');
    expect(mapped.id).toBe('cal-9');
  });

  it('maps 410 Gone (cancelled event) to not_found — Calendar-specific', () => {
    const mapped = mapGoogleError({ statusCode: 410 }, { resource: 'event', id: 'evt-9' }) as NotFoundError;
    expect(mapped).toBeInstanceOf(NotFoundError);
    expect(mapped.resource).toBe('event');
  });

  it('maps 400 to validation_error carrying the provider message', () => {
    const mapped = mapGoogleError({ statusCode: 400, message: 'Invalid time range' }) as ValidationError;
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.reason).toBe('Invalid time range');
  });

  it('maps 5xx and unknown shapes to provider_unavailable', () => {
    expect(mapGoogleError({ statusCode: 503 })).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGoogleError(new Error('socket hang up'))).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGoogleError(undefined)).toBeInstanceOf(ProviderUnavailableError);
  });
});
