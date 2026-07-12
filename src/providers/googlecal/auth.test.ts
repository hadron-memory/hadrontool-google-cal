import { describe, expect, it } from 'vitest';
import { decodeIdToken } from './auth.js';

/** Build a JWT-shaped string whose payload is the given claims. */
function idToken(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

describe('decodeIdToken', () => {
  it('extracts email and name from the claims', () => {
    expect(decodeIdToken(idToken({ email: 'u@example.com', name: 'U Ser' }))).toEqual({
      email: 'u@example.com',
      name: 'U Ser',
    });
  });

  it('nulls missing claims', () => {
    expect(decodeIdToken(idToken({ sub: '123' }))).toEqual({ email: null, name: null });
  });

  it('fails soft on malformed tokens', () => {
    expect(decodeIdToken('not-a-jwt')).toEqual({ email: null, name: null });
    expect(decodeIdToken('')).toEqual({ email: null, name: null });
  });
});
