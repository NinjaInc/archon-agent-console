import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import * as simpleWebAuthn from '@simplewebauthn/server';

import { authStoreDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { createAuthMiddleware } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService, type AuthConfig } from './auth.service.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Reads and validates passkey configuration. WebAuthn only works on https (or localhost) with a matching RP ID. */
function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const rawOrigin = env.APP_ORIGIN || 'http://localhost:3001';
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new AppError(`APP_ORIGIN is not a valid URL: ${rawOrigin}`, { code: 'AUTH_CONFIG_INVALID' });
  }
  if (origin.protocol !== 'https:' && !LOCAL_HOSTS.has(origin.hostname)) {
    throw new AppError('APP_ORIGIN must be https:// (passkeys do not work over plain http except on localhost).', {
      code: 'AUTH_CONFIG_INVALID',
    });
  }
  const rpId = env.RP_ID || origin.hostname;
  if (origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`)) {
    throw new AppError(`RP_ID "${rpId}" must equal APP_ORIGIN's host or be a parent domain of it.`, {
      code: 'AUTH_CONFIG_INVALID',
    });
  }
  if (!env.APP_ORIGIN) {
    console.warn('[auth] APP_ORIGIN is not set; defaulting to http://localhost:3001. Set APP_ORIGIN and RP_ID for real use.');
  }
  return {
    rpId,
    rpName: env.RP_NAME || 'Archon Agent Console',
    origin: origin.origin,
    sessionIdleMs: Number(env.SESSION_IDLE_MINUTES || 30) * 60_000,
    sessionMaxMs: Number(env.SESSION_MAX_HOURS || 12) * 3_600_000,
    bootstrapTtlMs: 15 * 60_000,
    challengeTtlMs: 5 * 60_000,
  };
}

const config = loadAuthConfig(process.env);

const authService = createAuthService({
  store: authStoreDb,
  users: {
    // Reuse an existing user row (keeps projects/settings from a password install); the
    // sentinel hash can never match a bcrypt comparison and no password path exists anyway.
    getOrCreateOwner: () => {
      const existing = userDb.getFirstUser();
      if (existing) {
        return { id: existing.id, username: existing.username };
      }
      const created = userDb.createUser('owner', '!passkey-only');
      return { id: Number(created.id), username: created.username };
    },
    getUserById: (id) => userDb.getUserById(id),
  },
  webauthn: simpleWebAuthn as never,
  config,
});

const middleware = createAuthMiddleware(authService, config.origin);

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'unknown'),
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'AUTH_RATE_LIMITED' });
    },
  });
}

/** Auth router (public ceremony endpoints plus session-gated passkey management). */
export const authRoutes = createAuthRouter(authService, {
  authenticateToken: middleware.authenticateToken,
  generalLimiter: limiter(5 * 60_000, 60),
  strictLimiter: limiter(5 * 60_000, 10),
  sessionMaxAgeSeconds: Math.floor(config.sessionMaxMs / 1000),
});

export const authenticateToken = middleware.authenticateToken;
export const enforceOrigin = middleware.enforceOrigin;
export const isAllowedOrigin = middleware.isAllowedOrigin;
export const authenticateWebSocket = middleware.authenticateWebSocket;
export const isSessionActive = middleware.isSessionActive;
export const authConfig = config;

/** Startup hook: prints a one-time bootstrap token on the console while no passkey exists. */
export function prepareAuthAtStartup(): void {
  const armed = authService.ensureBootstrapAtStartup(process.env.BOOTSTRAP_TOKEN);
  if (!armed) {
    return;
  }
  const minutes = Math.round(config.bootstrapTtlMs / 60_000);
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  FIRST-RUN SETUP: no passkey is registered yet.');
  console.log(`  Open ${config.origin} and register a passkey with this token`);
  console.log(`  (single use, expires in ${minutes} minutes):`);
  console.log('');
  console.log(`    ${armed.token}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
}

/** Recovery: wipes all passkeys and sessions, returns a new bootstrap token (used by `npm run passkey:reset`). */
export function resetPasskeyCredentials(): { token: string; expiresAt: number } {
  return authService.resetCredentials();
}
