import { createHash, randomBytes } from 'node:crypto';

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { AppError } from '@/shared/utils.js';

// -- Dependency contracts -----------------------------------------------------------------

type PasskeyRecord = {
  credential_id: string;
  user_id: number;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
};

type SessionRecord = {
  token_hash: string;
  user_id: number;
  passkey_id: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  user_agent: string | null;
  ip: string | null;
};

type AuthStore = {
  transaction<T>(work: () => T): T;
  countPasskeys(): number;
  listPasskeys(): PasskeyRecord[];
  getPasskey(credentialId: string): PasskeyRecord | undefined;
  insertPasskey(row: PasskeyRecord): void;
  updatePasskeyUse(credentialId: string, counter: number, usedAt: number): void;
  deletePasskey(credentialId: string): boolean;
  deleteAllPasskeys(): void;
  insertSession(row: SessionRecord): void;
  getSession(tokenHash: string): SessionRecord | undefined;
  touchSession(tokenHash: string, seenAt: number): void;
  revokeSession(tokenHash: string, revokedAt: number): void;
  revokeSessionsForPasskey(credentialId: string, revokedAt: number): void;
  revokeAllSessions(revokedAt: number): void;
  pruneSessions(now: number): void;
  insertBootstrapToken(row: { token_hash: string; created_at: number; expires_at: number; used_at: number | null }): void;
  getBootstrapToken(tokenHash: string): { expires_at: number; used_at: number | null } | undefined;
  consumeBootstrapToken(tokenHash: string, now: number): boolean;
  hasLiveBootstrapToken(now: number): boolean;
  deleteAllBootstrapTokens(): void;
};

type WebAuthnApi = {
  generateRegistrationOptions(options: Record<string, unknown>): Promise<{ challenge: string } & Record<string, unknown>>;
  verifyRegistrationResponse(options: Record<string, unknown>): Promise<{
    verified: boolean;
    registrationInfo?: {
      credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
      credentialDeviceType: string;
      credentialBackedUp: boolean;
    };
  }>;
  generateAuthenticationOptions(options: Record<string, unknown>): Promise<{ challenge: string } & Record<string, unknown>>;
  verifyAuthenticationResponse(options: Record<string, unknown>): Promise<{
    verified: boolean;
    authenticationInfo: { newCounter: number };
  }>;
};

export type AuthConfig = {
  rpId: string;
  rpName: string;
  /** Exact origin the browser uses, e.g. https://console.example.com */
  origin: string;
  sessionIdleMs: number;
  sessionMaxMs: number;
  bootstrapTtlMs: number;
  challengeTtlMs: number;
};

type AuthDependencies = {
  store: AuthStore;
  users: { getOrCreateOwner(): { id: number; username: string }; getUserById(id: number): { id: number; username: string } | undefined };
  webauthn: WebAuthnApi;
  config: AuthConfig;
  now?: () => number;
};

type RequestMeta = { userAgent?: string | null; ip?: string | null };

type ChallengeRecord = {
  challenge: string;
  kind: 'register' | 'login';
  /** Who authorised a registration: a bootstrap token hash, or an existing session hash. */
  authorisedBy?: { mode: 'bootstrap'; tokenHash: string } | { mode: 'session'; tokenHash: string };
  expiresAt: number;
};

export type AuthenticatedPrincipal = { userId: number; username: string; passkeyId: string | null; sessionHash: string };

const MAX_PENDING_CHALLENGES = 500;
const SESSION_TOUCH_INTERVAL_MS = 30_000;
const MIN_ENV_BOOTSTRAP_TOKEN_LENGTH = 24;
const OWNER_USER_HANDLE = new TextEncoder().encode('archon-console-owner');

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function authFailure(): AppError {
  // One message for every login failure so responses never reveal why.
  return new AppError('Authentication failed', { code: 'AUTH_FAILED', statusCode: 401 });
}

function sanitizePasskeyName(input: unknown, fallback: string): string {
  const name = typeof input === 'string' ? input.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 64) : '';
  return name || fallback;
}

/**
 * Creates the passkey-only authentication service: WebAuthn ceremonies,
 * one-time bootstrap tokens, server-side sessions and passkey revocation.
 * There is deliberately no password path.
 */
export function createAuthService(dependencies: AuthDependencies) {
  const { store, users, webauthn, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  // Challenges are single-use and short-lived; they live in memory because the
  // server is one process and a restart should invalidate any pending ceremony.
  const challenges = new Map<string, ChallengeRecord>();

  function pruneChallenges(): void {
    const current = now();
    for (const [id, record] of challenges) {
      if (record.expiresAt <= current) {
        challenges.delete(id);
      }
    }
  }

  function storeChallenge(record: ChallengeRecord): string {
    pruneChallenges();
    if (challenges.size >= MAX_PENDING_CHALLENGES) {
      throw new AppError('Too many pending requests', { code: 'AUTH_BUSY', statusCode: 429 });
    }
    const id = randomBytes(24).toString('base64url');
    challenges.set(id, record);
    return id;
  }

  /** Removes and returns a challenge; it can never be replayed. */
  function takeChallenge(id: unknown, kind: ChallengeRecord['kind']): ChallengeRecord {
    const record = typeof id === 'string' ? challenges.get(id) : undefined;
    if (typeof id === 'string') {
      challenges.delete(id);
    }
    if (!record || record.kind !== kind || record.expiresAt <= now()) {
      throw new AppError('This request expired. Please try again.', { code: 'AUTH_CHALLENGE_INVALID', statusCode: 400 });
    }
    return record;
  }

  function createSession(userId: number, passkeyId: string | null, meta: RequestMeta) {
    const token = randomBytes(32).toString('base64url');
    const current = now();
    store.insertSession({
      token_hash: sha256Hex(token),
      user_id: userId,
      passkey_id: passkeyId,
      created_at: current,
      last_seen_at: current,
      expires_at: current + config.sessionMaxMs,
      revoked_at: null,
      user_agent: meta.userAgent?.slice(0, 200) ?? null,
      ip: meta.ip ?? null,
    });
    store.pruneSessions(current);
    return { token, expiresAt: current + config.sessionMaxMs };
  }

  /** Resolves a session cookie value to its principal, enforcing revocation, idle and absolute expiry. */
  function validateSession(token: string | null | undefined, options: { touch?: boolean } = {}): AuthenticatedPrincipal | null {
    if (!token) {
      return null;
    }
    const tokenHash = sha256Hex(token);
    const session = store.getSession(tokenHash);
    if (!session || session.revoked_at !== null) {
      return null;
    }
    const current = now();
    if (current >= session.expires_at || current - session.last_seen_at > config.sessionIdleMs) {
      store.revokeSession(tokenHash, current);
      return null;
    }
    const user = users.getUserById(session.user_id);
    if (!user) {
      return null;
    }
    // Re-validation of an open websocket must not count as user activity, or an idle tab would never time out.
    if (options.touch !== false && current - session.last_seen_at > SESSION_TOUCH_INTERVAL_MS) {
      store.touchSession(tokenHash, current);
    }
    return { userId: user.id, username: user.username, passkeyId: session.passkey_id, sessionHash: tokenHash };
  }

  function bootstrapTokenIsLive(token: unknown): token is string {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
      return false;
    }
    const record = store.getBootstrapToken(sha256Hex(token));
    return Boolean(record && record.used_at === null && record.expires_at > now());
  }

  /** Decides who may register a passkey: a bootstrap token while none exist, otherwise a live session. */
  function authoriseRegistration(input: { bootstrapToken?: unknown; sessionToken?: string | null }): NonNullable<ChallengeRecord['authorisedBy']> {
    if (store.countPasskeys() === 0) {
      if (!bootstrapTokenIsLive(input.bootstrapToken)) {
        throw new AppError('A valid, unexpired bootstrap token is required.', { code: 'AUTH_BOOTSTRAP_INVALID', statusCode: 401 });
      }
      return { mode: 'bootstrap', tokenHash: sha256Hex(input.bootstrapToken) };
    }
    const principal = validateSession(input.sessionToken);
    if (!principal) {
      throw new AppError('Sign in with an existing passkey to add another.', { code: 'AUTH_REQUIRED', statusCode: 401 });
    }
    return { mode: 'session', tokenHash: principal.sessionHash };
  }

  return {
    /** Public status: whether first-run setup is needed and whether the caller is signed in. */
    getStatus(sessionToken: string | null | undefined) {
      return {
        needsSetup: store.countPasskeys() === 0,
        isAuthenticated: validateSession(sessionToken) !== null,
      };
    },

    validateSession,

    /**
     * Arms first-run registration. Used at server start and by `npm run passkey:reset`.
     * Returns the plaintext token exactly once for printing; only its hash is stored.
     */
    issueBootstrapToken(explicitToken?: string): { token: string; expiresAt: number } {
      if (explicitToken !== undefined && explicitToken.length < MIN_ENV_BOOTSTRAP_TOKEN_LENGTH) {
        throw new AppError(`BOOTSTRAP_TOKEN must be at least ${MIN_ENV_BOOTSTRAP_TOKEN_LENGTH} characters.`, {
          code: 'AUTH_BOOTSTRAP_WEAK',
          statusCode: 500,
        });
      }
      const token = explicitToken ?? randomBytes(32).toString('base64url');
      const current = now();
      store.insertBootstrapToken({
        token_hash: sha256Hex(token),
        created_at: current,
        expires_at: current + config.bootstrapTtlMs,
        used_at: null,
      });
      return { token, expiresAt: current + config.bootstrapTtlMs };
    },

    /** Startup hook: when no passkey exists, make sure a live bootstrap token is available. */
    ensureBootstrapAtStartup(envToken: string | undefined): { token: string; expiresAt: number } | null {
      if (store.countPasskeys() > 0) {
        return null;
      }
      if (envToken) {
        return this.issueBootstrapToken(envToken);
      }
      // A random token is printed once and cannot be recovered later, so a
      // previous unused one is replaced rather than reused.
      store.deleteAllBootstrapTokens();
      return this.issueBootstrapToken();
    },

    /** Wipes every credential, session and bootstrap token, then arms a fresh bootstrap token (recovery CLI). */
    resetCredentials(): { token: string; expiresAt: number } {
      return store.transaction(() => {
        store.deleteAllPasskeys();
        store.revokeAllSessions(now());
        store.deleteAllBootstrapTokens();
        return this.issueBootstrapToken();
      });
    },

    async beginRegistration(input: { bootstrapToken?: unknown; sessionToken?: string | null }) {
      const authorisedBy = authoriseRegistration(input);
      const owner = users.getOrCreateOwner();
      const options = await webauthn.generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpId,
        userName: owner.username,
        userDisplayName: 'Console owner',
        userID: OWNER_USER_HANDLE,
        attestationType: 'none',
        excludeCredentials: store.listPasskeys().map((passkey) => ({
          id: passkey.credential_id,
          transports: passkey.transports ? (JSON.parse(passkey.transports) as string[]) : undefined,
        })),
        // Discoverable credentials so login needs no username; UV so a stolen
        // authenticator alone is not enough.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const challengeId = storeChallenge({
        challenge: options.challenge,
        kind: 'register',
        authorisedBy,
        expiresAt: now() + config.challengeTtlMs,
      });
      return { challengeId, options };
    },

    async finishRegistration(input: {
      challengeId: unknown;
      response: unknown;
      name?: unknown;
      bootstrapToken?: unknown;
      sessionToken?: string | null;
      meta: RequestMeta;
    }) {
      const record = takeChallenge(input.challengeId, 'register');
      // Re-check authorisation: the bootstrap token may have expired, or the
      // session been revoked, between the two steps.
      const authorisedBy = authoriseRegistration(input);
      if (!record.authorisedBy || record.authorisedBy.mode !== authorisedBy.mode || record.authorisedBy.tokenHash !== authorisedBy.tokenHash) {
        throw new AppError('Registration was not authorised.', { code: 'AUTH_REQUIRED', statusCode: 401 });
      }

      let verification;
      try {
        verification = await webauthn.verifyRegistrationResponse({
          response: input.response as RegistrationResponseJSON,
          expectedChallenge: record.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          requireUserVerification: true,
        });
      } catch {
        throw new AppError('Passkey registration could not be verified.', { code: 'AUTH_REGISTRATION_FAILED', statusCode: 400 });
      }
      if (!verification.verified || !verification.registrationInfo) {
        throw new AppError('Passkey registration could not be verified.', { code: 'AUTH_REGISTRATION_FAILED', statusCode: 400 });
      }
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      return store.transaction(() => {
        if (authorisedBy.mode === 'bootstrap') {
          // Both checks run in the same transaction, so two racing first-run
          // registrations cannot both succeed.
          if (store.countPasskeys() !== 0 || !store.consumeBootstrapToken(authorisedBy.tokenHash, now())) {
            throw new AppError('Setup was already completed.', { code: 'AUTH_SETUP_DONE', statusCode: 409 });
          }
        }
        if (store.getPasskey(credential.id)) {
          throw new AppError('This passkey is already registered.', { code: 'AUTH_PASSKEY_EXISTS', statusCode: 409 });
        }
        const owner = users.getOrCreateOwner();
        const createdAt = now();
        const name = sanitizePasskeyName(input.name, `Passkey ${store.countPasskeys() + 1}`);
        store.insertPasskey({
          credential_id: credential.id,
          user_id: owner.id,
          public_key: toBase64Url(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ? JSON.stringify(credential.transports) : null,
          device_type: credentialDeviceType,
          backed_up: credentialBackedUp ? 1 : 0,
          name,
          created_at: createdAt,
          last_used_at: null,
        });
        // First-run registration signs the owner in; adding a passkey keeps the current session.
        const session = authorisedBy.mode === 'bootstrap' ? createSession(owner.id, credential.id, input.meta) : null;
        return { passkey: { id: credential.id, name, createdAt }, session };
      });
    },

    async beginLogin() {
      const options = await webauthn.generateAuthenticationOptions({
        rpID: config.rpId,
        userVerification: 'required',
      });
      const challengeId = storeChallenge({
        challenge: options.challenge,
        kind: 'login',
        expiresAt: now() + config.challengeTtlMs,
      });
      return { challengeId, options };
    },

    async finishLogin(input: { challengeId: unknown; response: unknown; meta: RequestMeta }) {
      const record = takeChallenge(input.challengeId, 'login');
      const response = input.response as AuthenticationResponseJSON;
      const passkey = typeof response?.id === 'string' ? store.getPasskey(response.id) : undefined;
      if (!passkey) {
        throw authFailure();
      }

      let verification;
      try {
        verification = await webauthn.verifyAuthenticationResponse({
          response,
          expectedChallenge: record.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          requireUserVerification: true,
          credential: {
            id: passkey.credential_id,
            publicKey: fromBase64Url(passkey.public_key),
            counter: passkey.counter,
            transports: passkey.transports ? (JSON.parse(passkey.transports) as string[]) : undefined,
          },
        });
      } catch {
        throw authFailure();
      }
      if (!verification.verified) {
        throw authFailure();
      }

      const current = now();
      store.updatePasskeyUse(passkey.credential_id, verification.authenticationInfo.newCounter, current);
      const user = users.getUserById(passkey.user_id);
      if (!user) {
        throw authFailure();
      }
      return { user, session: createSession(user.id, passkey.credential_id, input.meta) };
    },

    logout(sessionToken: string | null | undefined): void {
      if (sessionToken) {
        store.revokeSession(sha256Hex(sessionToken), now());
      }
    },

    revokeAllSessions(): void {
      store.revokeAllSessions(now());
    },

    /** Public view of registered passkeys; never includes key material. */
    listPasskeys(currentPasskeyId: string | null) {
      return store.listPasskeys().map((passkey) => ({
        id: passkey.credential_id,
        name: passkey.name,
        createdAt: passkey.created_at,
        lastUsedAt: passkey.last_used_at,
        deviceType: passkey.device_type,
        backedUp: passkey.backed_up === 1,
        isCurrent: passkey.credential_id === currentPasskeyId,
      }));
    },

    /** Revokes one passkey and every session it created. The last passkey cannot be removed remotely. */
    revokePasskey(credentialId: unknown, currentPasskeyId: string | null) {
      if (typeof credentialId !== 'string' || !credentialId) {
        throw new AppError('Passkey id is required.', { code: 'AUTH_PASSKEY_ID_REQUIRED', statusCode: 400 });
      }
      return store.transaction(() => {
        if (!store.getPasskey(credentialId)) {
          throw new AppError('Passkey not found.', { code: 'AUTH_PASSKEY_NOT_FOUND', statusCode: 404 });
        }
        if (store.countPasskeys() <= 1) {
          throw new AppError(
            'Cannot remove the last passkey. Add another first, or run `npm run passkey:reset` on the server.',
            { code: 'AUTH_LAST_PASSKEY', statusCode: 409 },
          );
        }
        store.deletePasskey(credentialId);
        store.revokeSessionsForPasskey(credentialId, now());
        return { revoked: true, revokedCurrentSession: credentialId === currentPasskeyId };
      });
    },
  };
}
