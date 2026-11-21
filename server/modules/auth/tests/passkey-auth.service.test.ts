import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The real SQLite store is exercised against a throwaway database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-auth-'));
process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');

const simpleWebAuthn = await import('@simplewebauthn/server');
const { authStoreDb, initializeDatabase, userDb, getConnection } = await import('@/modules/database/index.js');
const { createAuthService } = await import('../auth.service.js');
const { VirtualAuthenticator } = await import('./virtual-authenticator.js');

await initializeDatabase();

const RP_ID = 'console.test';
const ORIGIN = 'https://console.test';
const MIN = 60_000;
let clock = 1_800_000_000_000;

const config = {
  rpId: RP_ID,
  rpName: 'Test Console',
  origin: ORIGIN,
  sessionIdleMs: 30 * MIN,
  sessionMaxMs: 12 * 60 * MIN,
  bootstrapTtlMs: 15 * MIN,
  challengeTtlMs: 5 * MIN,
};

const service = createAuthService({
  store: authStoreDb,
  users: {
    getOrCreateOwner: () => {
      const existing = userDb.getFirstUser();
      if (existing) return { id: existing.id, username: existing.username };
      const created = userDb.createUser('owner', '!passkey-only');
      return { id: Number(created.id), username: created.username };
    },
    getUserById: (id: number) => userDb.getUserById(id),
  },
  webauthn: simpleWebAuthn as never,
  config,
  now: () => clock,
});

const meta = { userAgent: 'test', ip: '127.0.0.1' };

/** Wipes auth state so each test starts from a fresh "first run". */
function resetState() {
  getConnection().exec('DELETE FROM auth_sessions; DELETE FROM passkeys; DELETE FROM bootstrap_tokens;');
  clock += 1000;
}

async function registerFirstPasskey(authenticator: InstanceType<typeof VirtualAuthenticator>) {
  const { token } = service.issueBootstrapToken();
  const { challengeId, options } = await service.beginRegistration({ bootstrapToken: token });
  const result = await service.finishRegistration({
    challengeId,
    response: authenticator.register(options.challenge),
    bootstrapToken: token,
    name: 'Laptop',
    meta,
  });
  return { token, result };
}

async function login(authenticator: InstanceType<typeof VirtualAuthenticator>, overrides: { counter?: number; originOverride?: string } = {}) {
  const { challengeId, options } = await service.beginLogin();
  return service.finishLogin({ challengeId, response: authenticator.assert(options.challenge, overrides), meta });
}

test('first run: a bootstrap token registers the first passkey and signs the owner in', async () => {
  resetState();
  assert.deepEqual(service.getStatus(null), { needsSetup: true, isAuthenticated: false });

  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { result } = await registerFirstPasskey(authenticator);

  assert.ok(result.session, 'bootstrap registration creates a session');
  assert.equal(service.getStatus(result.session.token).isAuthenticated, true);
  assert.equal(service.getStatus(null).needsSetup, false);
  assert.equal(service.listPasskeys(null).length, 1);
});

test('registration is refused without a valid bootstrap token', async () => {
  resetState();
  await assert.rejects(() => service.beginRegistration({}), { code: 'AUTH_BOOTSTRAP_INVALID' });
  await assert.rejects(() => service.beginRegistration({ bootstrapToken: 'x'.repeat(40) }), { code: 'AUTH_BOOTSTRAP_INVALID' });
});

test('a bootstrap token expires after 15 minutes', async () => {
  resetState();
  const { token } = service.issueBootstrapToken();
  clock += 15 * MIN + 1;
  await assert.rejects(() => service.beginRegistration({ bootstrapToken: token }), { code: 'AUTH_BOOTSTRAP_INVALID' });
});

test('a bootstrap token that expires between the two steps cannot finish registration', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { token } = service.issueBootstrapToken();
  // Start the ceremony late so the challenge (5 min) is still fresh when only the token (15 min) has expired.
  clock += 11 * MIN;
  const { challengeId, options } = await service.beginRegistration({ bootstrapToken: token });
  clock += 4 * MIN + 1000;
  await assert.rejects(
    () => service.finishRegistration({ challengeId, response: authenticator.register(options.challenge), bootstrapToken: token, meta }),
    { code: 'AUTH_BOOTSTRAP_INVALID' },
  );
  assert.equal(service.listPasskeys(null).length, 0);
});

test('after the first passkey, bootstrap tokens no longer register anything; a session is required', async () => {
  resetState();
  const first = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { token, result } = await registerFirstPasskey(first);

  // The used token is useless, and so is a brand-new one without a session.
  await assert.rejects(() => service.beginRegistration({ bootstrapToken: token }), { code: 'AUTH_REQUIRED' });
  const fresh = service.issueBootstrapToken();
  await assert.rejects(() => service.beginRegistration({ bootstrapToken: fresh.token }), { code: 'AUTH_REQUIRED' });

  // With the signed-in session a second passkey can be added.
  const second = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { challengeId, options } = await service.beginRegistration({ sessionToken: result.session!.token });
  const added = await service.finishRegistration({
    challengeId,
    response: second.register(options.challenge),
    sessionToken: result.session!.token,
    name: 'Phone',
    meta,
  });
  assert.equal(added.session, null, 'adding a passkey keeps the existing session');
  assert.equal(service.listPasskeys(null).length, 2);
});

test('two racing first-run registrations cannot both succeed', async () => {
  resetState();
  const { token } = service.issueBootstrapToken();
  const a = new VirtualAuthenticator(RP_ID, ORIGIN);
  const b = new VirtualAuthenticator(RP_ID, ORIGIN);
  const [ca, cb] = await Promise.all([
    service.beginRegistration({ bootstrapToken: token }),
    service.beginRegistration({ bootstrapToken: token }),
  ]);
  const outcomes = await Promise.allSettled([
    service.finishRegistration({ challengeId: ca.challengeId, response: a.register(ca.options.challenge), bootstrapToken: token, meta }),
    service.finishRegistration({ challengeId: cb.challengeId, response: b.register(cb.options.challenge), bootstrapToken: token, meta }),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(service.listPasskeys(null).length, 1);
});

test('registration from the wrong origin (phishing) is rejected', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { token } = service.issueBootstrapToken();
  const { challengeId, options } = await service.beginRegistration({ bootstrapToken: token });
  await assert.rejects(
    () => service.finishRegistration({
      challengeId,
      response: authenticator.register(options.challenge, { originOverride: 'https://evil.test' }),
      bootstrapToken: token,
      meta,
    }),
    { code: 'AUTH_REGISTRATION_FAILED' },
  );
  assert.equal(service.listPasskeys(null).length, 0);
});

test('login: a registered passkey signs in; replayed challenges, wrong origins and unknown keys are refused', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerFirstPasskey(authenticator);

  const ok = await login(authenticator);
  assert.ok(service.validateSession(ok.session.token));

  // A challenge is single-use.
  const { challengeId, options } = await service.beginLogin();
  const response = authenticator.assert(options.challenge);
  await service.finishLogin({ challengeId, response, meta });
  await assert.rejects(() => service.finishLogin({ challengeId, response, meta }), { code: 'AUTH_CHALLENGE_INVALID' });

  await assert.rejects(() => login(authenticator, { originOverride: 'https://evil.test' }), { code: 'AUTH_FAILED' });

  const stranger = new VirtualAuthenticator(RP_ID, ORIGIN);
  await assert.rejects(() => login(stranger), { code: 'AUTH_FAILED' });
});

test('login: a stale signature counter (cloned authenticator) is refused', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerFirstPasskey(authenticator);
  await login(authenticator, { counter: 10 });
  await assert.rejects(() => login(authenticator, { counter: 5 }), { code: 'AUTH_FAILED' });
});

test('login challenges expire after 5 minutes', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerFirstPasskey(authenticator);
  const { challengeId, options } = await service.beginLogin();
  clock += 5 * MIN + 1;
  await assert.rejects(
    () => service.finishLogin({ challengeId, response: authenticator.assert(options.challenge), meta }),
    { code: 'AUTH_CHALLENGE_INVALID' },
  );
});

test('sessions: idle timeout, absolute timeout, logout and revoke-all all end the session', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  await registerFirstPasskey(authenticator);

  const idle = (await login(authenticator)).session;
  clock += 29 * MIN;
  assert.ok(service.validateSession(idle.token), 'activity within the idle window keeps it alive');
  clock += 31 * MIN;
  assert.equal(service.validateSession(idle.token), null, 'idle > 30 min ends the session');

  const absolute = (await login(authenticator)).session;
  for (let i = 0; i < 25; i += 1) {
    clock += 29 * MIN;
    service.validateSession(absolute.token);
  }
  clock += 29 * MIN;
  assert.equal(service.validateSession(absolute.token), null, 'absolute lifetime (12h) ends even an active session');

  const loggedOut = (await login(authenticator)).session;
  service.logout(loggedOut.token);
  assert.equal(service.validateSession(loggedOut.token), null);

  const swept = (await login(authenticator)).session;
  service.revokeAllSessions();
  assert.equal(service.validateSession(swept.token), null);
});

test('sessions: tokens are stored only as hashes', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { result } = await registerFirstPasskey(authenticator);
  const rows = getConnection().prepare('SELECT token_hash FROM auth_sessions').all() as Array<{ token_hash: string }>;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.token_hash !== result.session!.token && row.token_hash.length === 64));
});

test('revoking a passkey ends its sessions only, and the last passkey cannot be revoked', async () => {
  resetState();
  const first = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { result } = await registerFirstPasskey(first);
  await assert.rejects(() => Promise.resolve().then(() => service.revokePasskey(first.id, first.id)), { code: 'AUTH_LAST_PASSKEY' });

  const second = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { challengeId, options } = await service.beginRegistration({ sessionToken: result.session!.token });
  await service.finishRegistration({ challengeId, response: second.register(options.challenge), sessionToken: result.session!.token, meta });

  const firstSession = (await login(first)).session;
  const secondSession = (await login(second)).session;

  const revoked = service.revokePasskey(second.id, first.id);
  assert.equal(revoked.revokedCurrentSession, false);
  assert.equal(service.validateSession(secondSession.token), null, "the revoked passkey's session is gone");
  assert.ok(service.validateSession(firstSession.token), 'other sessions survive');
  await assert.rejects(() => login(second), { code: 'AUTH_FAILED' });
});

test('passkey:reset wipes credentials and sessions and arms a fresh bootstrap token', async () => {
  resetState();
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { result } = await registerFirstPasskey(authenticator);

  const { token } = service.resetCredentials();
  assert.equal(service.validateSession(result.session!.token), null);
  assert.equal(service.getStatus(null).needsSetup, true);
  assert.equal(service.listPasskeys(null).length, 0);

  const replacement = new VirtualAuthenticator(RP_ID, ORIGIN);
  const { challengeId, options } = await service.beginRegistration({ bootstrapToken: token });
  const registered = await service.finishRegistration({ challengeId, response: replacement.register(options.challenge), bootstrapToken: token, meta });
  assert.ok(registered.session);
});

test('an env-provided bootstrap token must be long enough', () => {
  resetState();
  assert.throws(() => service.issueBootstrapToken('short'), { code: 'AUTH_BOOTSTRAP_WEAK' });
  assert.ok(service.issueBootstrapToken('a'.repeat(32)).token);
});

test('startup arms a token only while no passkey exists', async () => {
  resetState();
  const armed = service.ensureBootstrapAtStartup(undefined);
  assert.ok(armed && armed.token.length >= 24);
  await registerFirstPasskey(new VirtualAuthenticator(RP_ID, ORIGIN));
  assert.equal(service.ensureBootstrapAtStartup(undefined), null);
});

test.after(() => {
  getConnection().close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('generated setup tokens are readable: grouped, no lookalike characters', () => {
  resetState();
  for (let i = 0; i < 25; i += 1) {
    const { token } = service.issueBootstrapToken();
    assert.match(token, /^([A-HJKMNP-Z2-9]{4}-){5}[A-HJKMNP-Z2-9]{4}$/, token);
  }
});

test('a pasted setup token still works in lowercase, without hyphens, or with stray spaces', async () => {
  for (const mangle of [
    (t: string) => t.toLowerCase(),
    (t: string) => t.replace(/-/g, ''),
    (t: string) => `  ${t.toLowerCase().replace(/-/g, ' ')} `,
  ]) {
    resetState();
    const { token } = service.issueBootstrapToken();
    const { options } = await service.beginRegistration({ bootstrapToken: mangle(token) });
    assert.ok(options.challenge);
  }
});

test('a wrong or lookalike-altered setup token is still refused', async () => {
  resetState();
  const { token } = service.issueBootstrapToken();
  const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(service.beginRegistration({ bootstrapToken: wrong }), { code: 'AUTH_BOOTSTRAP_INVALID' });
});

test('an env-provided BOOTSTRAP_TOKEN must still match exactly (no case folding)', async () => {
  resetState();
  const custom = 'My-Own-Custom-Setup-Token-2026';
  service.issueBootstrapToken(custom);
  await assert.rejects(service.beginRegistration({ bootstrapToken: custom.toUpperCase() }), { code: 'AUTH_BOOTSTRAP_INVALID' });
  const { options } = await service.beginRegistration({ bootstrapToken: custom });
  assert.ok(options.challenge);
});
