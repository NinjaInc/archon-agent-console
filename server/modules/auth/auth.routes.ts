import express from 'express';
import type { RequestHandler } from 'express';

import { SESSION_COOKIE_NAME, readSessionCookie } from './auth.middleware.js';
import type { createAuthService } from './auth.service.js';

type AuthService = ReturnType<typeof createAuthService>;
type AuthenticatedRequest = express.Request & { user?: unknown; passkeyId?: string | null };

type AuthRouterOptions = {
  authenticateToken: RequestHandler;
  /** Applied to every auth route (broad per-IP limit). */
  generalLimiter: RequestHandler;
  /** Applied to the verify/bootstrap steps that an attacker would brute-force. */
  strictLimiter: RequestHandler;
  sessionMaxAgeSeconds: number;
};

function clientMeta(req: express.Request) {
  return { userAgent: req.headers['user-agent'] ?? null, ip: req.ip ?? null };
}

/** Creates the passkey auth transport adapter. Handlers parse input and delegate to the service. */
export function createAuthRouter(service: AuthService, options: AuthRouterOptions): express.Router {
  const router = express.Router();
  router.use(options.generalLimiter);

  function setSessionCookie(res: express.Response, token: string): void {
    // Secure is unconditional: the app sits behind an HTTPS tunnel, and browsers
    // treat http://localhost as secure for cookies during local development.
    res.append(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${options.sessionMaxAgeSeconds}`,
    );
  }

  function clearSessionCookie(res: express.Response): void {
    res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  }

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/status', (req, res) => {
    res.json(service.getStatus(readSessionCookie(req.headers.cookie)));
  });

  router.post('/register/options', options.strictLimiter, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { bootstrapToken?: unknown };
      res.json(
        await service.beginRegistration({
          bootstrapToken: body.bootstrapToken,
          sessionToken: readSessionCookie(req.headers.cookie),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/register/verify', options.strictLimiter, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { challengeId?: unknown; response?: unknown; name?: unknown; bootstrapToken?: unknown };
      const result = await service.finishRegistration({
        challengeId: body.challengeId,
        response: body.response,
        name: body.name,
        bootstrapToken: body.bootstrapToken,
        sessionToken: readSessionCookie(req.headers.cookie),
        meta: clientMeta(req),
      });
      if (result.session) {
        setSessionCookie(res, result.session.token);
      }
      res.json({ success: true, passkey: result.passkey, signedIn: Boolean(result.session) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login/options', async (_req, res, next) => {
    try {
      res.json(await service.beginLogin());
    } catch (error) {
      next(error);
    }
  });

  router.post('/login/verify', options.strictLimiter, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { challengeId?: unknown; response?: unknown };
      const result = await service.finishLogin({
        challengeId: body.challengeId,
        response: body.response,
        meta: clientMeta(req),
      });
      setSessionCookie(res, result.session.token);
      res.json({ success: true, user: { id: result.user.id, username: result.user.username } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', options.authenticateToken, (req, res) => {
    res.json({ user: (req as AuthenticatedRequest).user });
  });

  router.post('/logout', (req, res) => {
    service.logout(readSessionCookie(req.headers.cookie));
    clearSessionCookie(res);
    res.json({ success: true, message: 'Logged out successfully' });
  });

  router.post('/sessions/revoke-all', options.authenticateToken, (_req, res) => {
    service.revokeAllSessions();
    clearSessionCookie(res);
    res.json({ success: true });
  });

  router.get('/passkeys', options.authenticateToken, (req, res) => {
    res.json({ passkeys: service.listPasskeys((req as AuthenticatedRequest).passkeyId ?? null) });
  });

  router.delete('/passkeys/:credentialId', options.authenticateToken, (req, res, next) => {
    try {
      const result = service.revokePasskey(req.params.credentialId, (req as AuthenticatedRequest).passkeyId ?? null);
      if (result.revokedCurrentSession) {
        clearSessionCookie(res);
      }
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
