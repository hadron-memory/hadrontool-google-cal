/**
 * Boot: env validation (config.ts import throws on production misconfig) and
 * the HTTP server. No workers in v1 — there is no watch/event plane, and the
 * idempotency ledger is small enough that pruning waits for the v2 worker.
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { logInfo } from './logger.js';
import { googleCalProvider } from './providers/googlecal/client.js';

const app = createApp(db, googleCalProvider);

app.listen(config.port, () => {
  logInfo(`hadrontool-google-cal listening on :${config.port}`);
  if (!config.googleClientId || !config.googleClientSecret) {
    logInfo('GOOGLE_CLIENT_ID/SECRET not set — provider calls will return provider_not_configured');
  }
});
