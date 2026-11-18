import type { IncomingMessage } from 'node:http';

import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

export type WebSocketAuthDependencies = {
  /** Polled for open sockets; false closes the socket (revoked passkey, logout, idle or absolute timeout). */
  isSessionActive: (request: IncomingMessage) => boolean;
  /** True when the Origin header is exactly this app's origin. */
  isAllowedOrigin: (origin: string | undefined) => boolean;
  /** Authenticates the upgrade from its session cookie; null when missing, expired or revoked. */
  authenticateWebSocket: (request: IncomingMessage) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
  /** Optional extra gate (Cloudflare Access JWT); returns false to refuse the upgrade. */
  verifyEdgeAccess?: (request: IncomingMessage) => Promise<boolean> | boolean;
};

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 * Order: Origin (blocks cross-site websocket hijacking), then the session cookie.
 * Every path - /shell, /ws, plugin proxies - goes through here, so none is reachable unauthenticated.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradePath = new URL(request.url ?? '/', 'http://localhost').pathname;

  if (!dependencies.isAllowedOrigin(request.headers.origin)) {
    console.log('[WARN] WebSocket rejected: origin not allowed', upgradePath);
    return false;
  }

  const user = dependencies.authenticateWebSocket(request);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed', upgradePath);
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username, upgradePath);
  return true;
}
