// authRoutes: used by the server entrypoint to mount the public passkey ceremony and session-gated management endpoints.
export { authRoutes } from './auth.module.js';
// authenticateToken: used by the server entrypoint to protect authenticated API modules with the session cookie.
export { authenticateToken } from './auth.module.js';
// authenticateWebSocket: used by WebSocket setup to authenticate upgrades from the session cookie.
export { authenticateWebSocket } from './auth.module.js';
// isSessionActive: used by WebSocket setup to drop open sockets whose session was revoked or timed out.
export { isSessionActive } from './auth.module.js';
// enforceOrigin, isAllowedOrigin: used by the server entrypoint and WebSocket setup to reject cross-origin writes and upgrades.
export { enforceOrigin, isAllowedOrigin, authConfig } from './auth.module.js';
// prepareAuthAtStartup: used by the server entrypoint to arm and print the first-run bootstrap token.
export { prepareAuthAtStartup } from './auth.module.js';
// resetPasskeyCredentials: used by the `passkey:reset` recovery CLI.
export { resetPasskeyCredentials } from './auth.module.js';
