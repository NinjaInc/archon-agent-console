/**
 * Client side of the passkey session.
 *
 * The session lives in an HttpOnly, Secure, SameSite=Strict cookie that the
 * browser attaches by itself and JavaScript can neither read nor steal, so there
 * is no token to store, refresh or attach to requests any more. What remains is
 * the one signal the rest of the app needs: "the server says the session ended".
 */

export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

/** Tells AuthContext the server rejected the session, so it can return to the login screen. */
export const expireAuthSession = (): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
};
