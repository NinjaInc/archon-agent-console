/**
 * Passkey authentication store.
 *
 * Persists WebAuthn credentials, server-side login sessions and one-time
 * bootstrap tokens. Session and bootstrap tokens are stored only as SHA-256
 * hashes, so a copy of the database cannot be replayed as a login.
 */

import { getConnection } from '@/modules/database/connection.js';

export type PasskeyRow = {
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

export type AuthSessionRow = {
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

export type BootstrapTokenRow = {
  token_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
};

// authStoreDb: used by the Auth module (service, middleware, reset CLI) for passkeys, sessions and bootstrap tokens.
export const authStoreDb = {
  /** Runs `work` inside one SQLite transaction; any throw rolls everything back. */
  transaction<T>(work: () => T): T {
    return getConnection().transaction(work)();
  },

  countPasskeys(): number {
    const row = getConnection().prepare('SELECT COUNT(*) AS count FROM passkeys').get() as { count: number };
    return row.count;
  },

  listPasskeys(): PasskeyRow[] {
    return getConnection().prepare('SELECT * FROM passkeys ORDER BY created_at ASC').all() as PasskeyRow[];
  },

  getPasskey(credentialId: string): PasskeyRow | undefined {
    return getConnection().prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId) as PasskeyRow | undefined;
  },

  insertPasskey(row: PasskeyRow): void {
    getConnection()
      .prepare(`INSERT INTO passkeys
        (credential_id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at)
        VALUES (@credential_id, @user_id, @public_key, @counter, @transports, @device_type, @backed_up, @name, @created_at, @last_used_at)`)
      .run(row);
  },

  updatePasskeyUse(credentialId: string, counter: number, usedAt: number): void {
    getConnection()
      .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?')
      .run(counter, usedAt, credentialId);
  },

  /** Returns true when a row was removed. */
  deletePasskey(credentialId: string): boolean {
    return getConnection().prepare('DELETE FROM passkeys WHERE credential_id = ?').run(credentialId).changes > 0;
  },

  deleteAllPasskeys(): void {
    getConnection().prepare('DELETE FROM passkeys').run();
  },

  insertSession(row: AuthSessionRow): void {
    getConnection()
      .prepare(`INSERT INTO auth_sessions
        (token_hash, user_id, passkey_id, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip)
        VALUES (@token_hash, @user_id, @passkey_id, @created_at, @last_seen_at, @expires_at, @revoked_at, @user_agent, @ip)`)
      .run(row);
  },

  getSession(tokenHash: string): AuthSessionRow | undefined {
    return getConnection().prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as AuthSessionRow | undefined;
  },

  touchSession(tokenHash: string, seenAt: number): void {
    getConnection().prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(seenAt, tokenHash);
  },

  revokeSession(tokenHash: string, revokedAt: number): void {
    getConnection()
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(revokedAt, tokenHash);
  },

  revokeSessionsForPasskey(credentialId: string, revokedAt: number): void {
    getConnection()
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE passkey_id = ? AND revoked_at IS NULL')
      .run(revokedAt, credentialId);
  },

  revokeAllSessions(revokedAt: number): void {
    getConnection().prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(revokedAt);
  },

  /** Drops sessions that can never be valid again (expired or revoked more than a day ago). */
  pruneSessions(now: number): void {
    getConnection()
      .prepare('DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
      .run(now, now - 24 * 60 * 60 * 1000);
  },

  insertBootstrapToken(row: BootstrapTokenRow): void {
    getConnection()
      .prepare('INSERT OR REPLACE INTO bootstrap_tokens (token_hash, created_at, expires_at, used_at) VALUES (@token_hash, @created_at, @expires_at, @used_at)')
      .run(row);
  },

  getBootstrapToken(tokenHash: string): BootstrapTokenRow | undefined {
    return getConnection().prepare('SELECT * FROM bootstrap_tokens WHERE token_hash = ?').get(tokenHash) as BootstrapTokenRow | undefined;
  },

  /** Atomically marks the token used; returns false if it was already used or has expired. */
  consumeBootstrapToken(tokenHash: string, now: number): boolean {
    return (
      getConnection()
        .prepare('UPDATE bootstrap_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
        .run(now, tokenHash, now).changes > 0
    );
  },

  hasLiveBootstrapToken(now: number): boolean {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM bootstrap_tokens WHERE used_at IS NULL AND expires_at > ?')
      .get(now) as { count: number };
    return row.count > 0;
  },

  deleteAllBootstrapTokens(): void {
    getConnection().prepare('DELETE FROM bootstrap_tokens').run();
  },
};
