import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';

import { IS_PLATFORM } from '@/shared/utils';
import { api, readApiErrorMessage } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';

/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  registrationFailed: 'errors.registrationFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
  passkeysUnsupported: 'errors.passkeysUnsupported',
  cancelled: 'errors.passkeyCancelled',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthStatusPayload = {
  needsSetup?: boolean;
  isAuthenticated?: boolean;
};

type AuthUserPayload = {
  user?: AuthUser;
};

type CeremonyOptionsPayload = {
  challengeId?: string;
  options?: unknown;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  /** Signs in with a discoverable passkey (no username). */
  loginWithPasskey: () => Promise<AuthActionResult>;
  /** First-run only: registers the first passkey using the one-time token printed on the server console. */
  setupWithPasskey: (bootstrapToken: string, name: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

// User activity pings keep the server's idle timer honest without a background poll.
const ACTIVITY_PING_INTERVAL_MS = 60_000;

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the passkey session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setUser(null);
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  // `t` changes identity on every language change; a ref keeps the startup check
  // from re-running (and flashing the loading screen) when the language changes.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // The server ending the session (idle timeout, revocation, logout elsewhere) returns to the login screen.
  useEffect(() => {
    const handleSessionExpired = () => {
      clearSession();
      setError(tRef.current(AUTH_ERROR_MESSAGES.sessionExpired));
    };
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [clearSession]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }
      setNeedsSetup(false);

      if (!statusPayload?.isAuthenticated) {
        return;
      }

      const userResponse = await api.auth.user();
      const userPayload = userResponse.ok ? await parseJsonSafely<AuthUserPayload>(userResponse) : null;
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      await checkOnboardingStatus();
      setUser(userPayload.user);
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(tRef.current(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  // While signed in, real user activity (not timers) tells the server the session is in use.
  useEffect(() => {
    if (IS_PLATFORM || !user) {
      return undefined;
    }
    let lastPing = Date.now();
    const handleActivity = () => {
      const current = Date.now();
      if (current - lastPing < ACTIVITY_PING_INTERVAL_MS) {
        return;
      }
      lastPing = current;
      void api.auth.status().catch(() => undefined);
    };
    const events = ['pointerdown', 'keydown', 'focus'] as const;
    events.forEach((name) => window.addEventListener(name, handleActivity, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, handleActivity));
  }, [user]);

  const failWith = useCallback((message: string): AuthActionResult => {
    setError(message);
    return { success: false, error: message };
  }, []);

  /** Maps a cancelled/blocked browser prompt to a friendly message instead of a stack trace. */
  const describeCeremonyError = useCallback((caughtError: unknown, fallbackKey: string): string => {
    if (caughtError instanceof Error && caughtError.name === 'NotAllowedError') {
      return t(AUTH_ERROR_MESSAGES.cancelled);
    }
    console.error('[Auth] Passkey ceremony failed:', caughtError);
    return t(fallbackKey);
  }, [t]);

  const completeSignIn = useCallback(async () => {
    const userResponse = await api.auth.user();
    const userPayload = userResponse.ok ? await parseJsonSafely<AuthUserPayload>(userResponse) : null;
    if (!userPayload?.user) {
      return false;
    }
    await checkOnboardingStatus();
    setUser(userPayload.user);
    setNeedsSetup(false);
    return true;
  }, [checkOnboardingStatus]);

  const loginWithPasskey = useCallback<AuthContextValue['loginWithPasskey']>(async () => {
    setError(null);
    if (!browserSupportsWebAuthn()) {
      return failWith(t(AUTH_ERROR_MESSAGES.passkeysUnsupported));
    }
    try {
      const optionsResponse = await api.auth.loginOptions();
      const begin = await parseJsonSafely<CeremonyOptionsPayload>(optionsResponse);
      if (!optionsResponse.ok || !begin?.challengeId || !begin.options) {
        return failWith(readApiErrorMessage(begin) ?? t(AUTH_ERROR_MESSAGES.loginFailed));
      }

      const assertion = await startAuthentication({ optionsJSON: begin.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      const verifyResponse = await api.auth.loginVerify({ challengeId: begin.challengeId, response: assertion });
      if (!verifyResponse.ok) {
        const payload = await parseJsonSafely<unknown>(verifyResponse);
        return failWith(readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.loginFailed));
      }

      return (await completeSignIn()) ? { success: true } : failWith(t(AUTH_ERROR_MESSAGES.loginFailed));
    } catch (caughtError) {
      return failWith(describeCeremonyError(caughtError, AUTH_ERROR_MESSAGES.loginFailed));
    }
  }, [completeSignIn, describeCeremonyError, failWith, t]);

  const setupWithPasskey = useCallback<AuthContextValue['setupWithPasskey']>(async (bootstrapToken, name) => {
    setError(null);
    if (!browserSupportsWebAuthn()) {
      return failWith(t(AUTH_ERROR_MESSAGES.passkeysUnsupported));
    }
    try {
      const optionsResponse = await api.auth.registerOptions(bootstrapToken.trim());
      const begin = await parseJsonSafely<CeremonyOptionsPayload>(optionsResponse);
      if (!optionsResponse.ok || !begin?.challengeId || !begin.options) {
        return failWith(readApiErrorMessage(begin) ?? t(AUTH_ERROR_MESSAGES.registrationFailed));
      }

      const attestation = await startRegistration({ optionsJSON: begin.options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      const verifyResponse = await api.auth.registerVerify({
        challengeId: begin.challengeId,
        response: attestation,
        name: name.trim() || undefined,
        bootstrapToken: bootstrapToken.trim(),
      });
      if (!verifyResponse.ok) {
        const payload = await parseJsonSafely<unknown>(verifyResponse);
        return failWith(readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.registrationFailed));
      }

      return (await completeSignIn()) ? { success: true } : failWith(t(AUTH_ERROR_MESSAGES.registrationFailed));
    } catch (caughtError) {
      return failWith(describeCeremonyError(caughtError, AUTH_ERROR_MESSAGES.registrationFailed));
    }
  }, [completeSignIn, describeCeremonyError, failWith, t]);

  const logout = useCallback(() => {
    // Revocation is server-side: the session row is revoked and the cookie cleared.
    void api.auth.logout().catch(() => undefined).finally(() => {
      clearSession();
    });
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      loginWithPasskey,
      setupWithPasskey,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      loginWithPasskey,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      setupWithPasskey,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
