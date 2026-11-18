import type { IncomingMessage } from 'node:http';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AuthenticatedPrincipal, createAuthService } from './auth.service.js';

/** `__Host-` pins the cookie to this exact host, requires Secure and Path=/, and forbids a Domain attribute. */
export const SESSION_COOKIE_NAME = '__Host-archon_session';

type AuthService = ReturnType<typeof createAuthService>;
type AuthenticatedRequest = Request & { user?: { id: number; username: string }; passkeyId?: string | null };

// Methods that cannot change state; everything else must come from the app's own origin.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reads one cookie from a raw Cookie header without trusting or evaluating its other values. */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      return value || null;
    }
  }
  return null;
}

/** Builds the middleware set from the auth service. Used by the Auth module composition root. */
export function createAuthMiddleware(service: AuthService, appOrigin: string) {
  /** Rejects any request that does not carry a valid, unexpired, unrevoked session cookie. */
  const authenticateToken: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const principal = service.validateSession(readSessionCookie(req.headers.cookie));
    if (!principal) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_TOKEN_INVALID' });
      return;
    }
    (req as AuthenticatedRequest).user = { id: principal.userId, username: principal.username };
    (req as AuthenticatedRequest).passkeyId = principal.passkeyId;
    next();
  };

  /** Browsers always send Origin on cross-site writes; require it to match this app for every state-changing /api call. */
  function enforceOrigin(exemptPrefixes: string[] = []): RequestHandler {
    return (req, res, next) => {
      if (SAFE_METHODS.has(req.method) || exemptPrefixes.some((prefix) => req.path.startsWith(prefix))) {
        next();
        return;
      }
      if (req.headers.origin !== appOrigin) {
        res.status(403).json({ error: 'Cross-origin request rejected.', code: 'ORIGIN_NOT_ALLOWED' });
        return;
      }
      next();
    };
  }

  return {
    authenticateToken,
    enforceOrigin,
    isAllowedOrigin: (origin: string | undefined): boolean => origin === appOrigin,
    /** True while the session behind an open websocket is still valid; does not count as user activity. */
    isSessionActive(request: IncomingMessage): boolean {
      return service.validateSession(readSessionCookie(request.headers.cookie), { touch: false }) !== null;
    },
    /** WebSocket upgrades authenticate with the same session cookie; returns null when it is missing or invalid. */
    authenticateWebSocket(request: IncomingMessage): { userId: number; username: string } | null {
      const principal: AuthenticatedPrincipal | null = service.validateSession(readSessionCookie(request.headers.cookie));
      return principal ? { userId: principal.userId, username: principal.username } : null;
    },
  };
}
