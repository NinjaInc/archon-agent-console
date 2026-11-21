import type { IncomingMessage } from 'node:http';

import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type CfAccessVerifierOptions = {
  /** e.g. https://myteam.cloudflareaccess.com - must equal the token's `iss`. */
  issuer: string;
  /** The Access application's AUD tag - must be one of the token's `aud` values. */
  audience: string;
  /** Resolves the signing key from the team JWKS (remote in production, local in tests). */
  keys: JWTVerifyGetKey;
};

export type CfAccessResult = { ok: true; email: string | null } | { ok: false; reason: string };

/**
 * Creates a verifier for the `Cf-Access-Jwt-Assertion` header Cloudflare Access adds to every
 * request it lets through. Verifies the signature against the team JWKS and checks `iss`, `aud`
 * and expiry. Only RS256 is accepted, so `alg: none` and HMAC confusion tokens are rejected.
 */
export function createCfAccessVerifier(options: CfAccessVerifierOptions) {
  return {
    async verify(token: unknown): Promise<CfAccessResult> {
      if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
        return { ok: false, reason: 'missing' };
      }
      try {
        const { payload } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat'],
          clockTolerance: 30,
        });
        return { ok: true, email: typeof payload.email === 'string' ? payload.email : null };
      } catch (error) {
        // The reason is for server logs only; the token itself is never logged.
        return { ok: false, reason: error instanceof Error ? error.name : 'invalid' };
      }
    },
  };
}

type Verifier = ReturnType<typeof createCfAccessVerifier>;

const ACCESS_HEADER = 'cf-access-jwt-assertion';

// Requests that came through the tunnel always carry Cloudflare's own headers.
const isViaCloudflare = (headers: IncomingMessage['headers']) => Boolean(headers['cf-ray'] || headers['cf-connecting-ip']);

/**
 * Express gate: when Access is required, every HTTP request needs a valid assertion.
 * The one exception is /healthz for local probes that did NOT come through Cloudflare.
 */
export function createCfAccessGate(verifier: Verifier | null, required: boolean): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!required || !verifier) {
      next();
      return;
    }
    if (req.path === '/healthz' && !isViaCloudflare(req.headers)) {
      next();
      return;
    }
    const result = await verifier.verify(req.headers[ACCESS_HEADER]);
    if (!result.ok) {
      console.warn(`[cf-access] rejected ${req.method} ${req.path}: ${result.reason}`);
      res.status(403).json({ error: 'Cloudflare Access verification failed.', code: 'CF_ACCESS_DENIED' });
      return;
    }
    next();
  };
}

/** Websocket-upgrade counterpart of the gate (upgrades never pass through Express middleware). */
export function createCfAccessUpgradeCheck(verifier: Verifier | null, required: boolean) {
  return async (request: IncomingMessage): Promise<boolean> => {
    if (!required || !verifier) {
      return true;
    }
    const result = await verifier.verify(request.headers[ACCESS_HEADER]);
    if (!result.ok) {
      console.warn(`[cf-access] rejected websocket upgrade: ${result.reason}`);
    }
    return result.ok;
  };
}
