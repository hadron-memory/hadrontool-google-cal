/**
 * Connection lifecycle — internal plane (bearer-gated).
 *
 * OAuth handoff (#396 pattern): hadron-server owns the user-facing flow and
 * the callback URL; this tool owns the client secret and the tokens. Core's
 * callback forwards the authorization code here; the tool exchanges it,
 * derives the account identity (ID-token claims first, OpenID userinfo
 * fallback), stores the encrypted refresh token, and returns the identity.
 * Core stores only that identity.
 *
 * Wire note: the identity's email field is named `mailboxEmail` — that is
 * the shared core contract (emailClient.ts validates the shape for every
 * provider tool); for this tool it carries the connected Google account's
 * email.
 */
import { Router } from 'express';
import { z } from 'zod';
import { encryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import { ConnectionNotFoundError, ValidationError } from '../errors.js';
import { logInfo } from '../logger.js';
import { decodeIdToken } from '../providers/googlecal/auth.js';
import type { GoogleCalProvider } from '../providers/googlecal/types.js';
import { respondWithError } from './respond.js';

const createSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().min(1),
});

/** Shape a Connection row into the identity JSON core consumes. */
function identityBody(connection: {
  id: string;
  provider: string;
  accountEmail: string;
  displayName: string | null;
  status: string;
}) {
  return {
    id: connection.id,
    provider: connection.provider,
    mailboxEmail: connection.accountEmail,
    displayName: connection.displayName,
    status: connection.status,
  };
}

/** Build the /connections router over injected db + provider. */
export function connectionsRouter(db: Db, provider: GoogleCalProvider): Router {
  const router = Router();

  // Create a connection from an OAuth authorization code.
  router.post('/', async (req, res) => {
    try {
      const input = createSchema.parse(req.body ?? {});

      const tokens = await provider.exchangeCode(input.code, input.redirectUri);
      // Google returns a refresh token only when the authorize URL carried
      // access_type=offline&prompt=consent — surface the real cause, not a
      // crypto crash.
      if (!tokens.refresh_token) {
        throw new ValidationError(
          'code',
          'Google did not return a refresh token — the authorize URL must carry access_type=offline&prompt=consent',
        );
      }

      // ID-token claims first, userinfo fallback.
      const idClaims = decodeIdToken(tokens.id_token ?? '');
      let accountEmail = idClaims.email;
      let displayName = idClaims.name;
      if (!accountEmail || !displayName) {
        const profile = await provider.fetchProfile(tokens.access_token);
        accountEmail = accountEmail ?? profile.email;
        displayName = displayName ?? profile.name;
      }
      if (!accountEmail) {
        throw new ValidationError('code', 'could not determine the account email from the Google account');
      }

      const connection = await db.connection.create({
        data: {
          accountEmail,
          displayName: displayName ?? null,
          refreshTokenEnc: encryptToken(tokens.refresh_token),
        },
      });
      logInfo(`connection created for ${connection.accountEmail} (${connection.id})`);
      res.status(201).json(identityBody(connection));
    } catch (err) {
      respondWithError(res, err, 'create connection');
    }
  });

  // Connection identity + status.
  router.get('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      res.json({ ...identityBody(connection), lastError: connection.lastError });
    } catch (err) {
      respondWithError(res, err, 'get connection');
    }
  });

  // Disconnect: soft-delete. (No provider-side teardown exists in v1 — there
  // are no watch channels; the refresh token simply stops being used. The
  // user can additionally revoke the grant at myaccount.google.com.)
  router.delete('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
      res.json({ deleted: true });
    } catch (err) {
      respondWithError(res, err, 'delete connection');
    }
  });

  return router;
}
