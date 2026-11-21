import assert from 'node:assert/strict';
import test from 'node:test';

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

import { createCfAccessGate, createCfAccessUpgradeCheck, createCfAccessVerifier } from '../cf-access.service.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-1234';

const trusted = await generateKeyPair('RS256');
const attacker = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(trusted.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const verifier = createCfAccessVerifier({ issuer: ISSUER, audience: AUD, keys: createLocalJWKSet({ keys: [jwk] }) });

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
type SignOptions = { key?: SigningKey; iss?: string; aud?: string | string[]; exp?: number | string; iat?: boolean; kid?: string };
async function token(options: SignOptions = {}) {
  const jwt = new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? AUD)
    .setExpirationTime(options.exp ?? '10m');
  if (options.iat !== false) jwt.setIssuedAt();
  return jwt.sign(options.key ?? trusted.privateKey);
}

test('a correctly signed, unexpired token for this app is accepted', async () => {
  const result = await verifier.verify(await token());
  assert.deepEqual(result, { ok: true, email: 'owner@example.com' });
});

test('a token whose aud list contains this app is accepted', async () => {
  assert.equal((await verifier.verify(await token({ aud: ['other', AUD] }))).ok, true);
});

test('a token for a different application (aud) is rejected', async () => {
  assert.equal((await verifier.verify(await token({ aud: 'someone-elses-app' }))).ok, false);
});

test('a token from a different issuer (iss) is rejected', async () => {
  assert.equal((await verifier.verify(await token({ iss: 'https://evil.cloudflareaccess.com' }))).ok, false);
});

test('an expired token is rejected', async () => {
  const expired = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await verifier.verify(await token({ exp: expired }))).ok, false);
});

test('a token signed with a key that is not in the team JWKS is rejected', async () => {
  assert.equal((await verifier.verify(await token({ key: attacker.privateKey }))).ok, false);
  // Even claiming the trusted key id does not help.
  assert.equal((await verifier.verify(await token({ key: attacker.privateKey, kid: 'k1' }))).ok, false);
});

test('a tampered payload is rejected', async () => {
  const [header, payload, signature] = (await token()).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), email: 'admin@example.com' })).toString('base64url');
  assert.equal((await verifier.verify(`${header}.${forged}.${signature}`)).ok, false);
});

test('alg:none and HS256 confusion tokens are rejected', async () => {
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUD, exp: 9999999999, iat: 1 })).toString('base64url')}.`;
  assert.equal((await verifier.verify(none)).ok, false);

  const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(AUD).setExpirationTime('10m').setIssuedAt()
    .sign(new TextEncoder().encode(JSON.stringify(jwk)));
  assert.equal((await verifier.verify(hs)).ok, false);
});

test('missing, empty, oversized and garbage values are rejected', async () => {
  for (const value of [undefined, '', 'not.a.jwt', 'x'.repeat(9000), 42, null, ['a', 'b']]) {
    assert.equal((await verifier.verify(value)).ok, false);
  }
});

test('a token with no expiry is rejected', async () => {
  const noExp = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(AUD).setIssuedAt().sign(trusted.privateKey);
  assert.equal((await verifier.verify(noExp)).ok, false);
});

function run(gate: ReturnType<typeof createCfAccessGate>, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; passed: boolean }>((resolve) => {
    const res = { status(code: number) { this.code = code; return this; }, json() { resolve({ status: this.code, passed: false }); }, code: 200 };
    void gate({ path, method: 'GET', headers } as never, res as never, () => resolve({ status: 200, passed: true }));
  });
}

test('gate: when required, requests without a valid assertion get 403 and valid ones pass', async () => {
  const gate = createCfAccessGate(verifier, true);
  assert.deepEqual(await run(gate, '/api/projects'), { status: 403, passed: false });
  assert.deepEqual(await run(gate, '/', { 'cf-access-jwt-assertion': 'garbage' }), { status: 403, passed: false });
  assert.deepEqual(await run(gate, '/api/projects', { 'cf-access-jwt-assertion': await token() }), { status: 200, passed: true });
});

test('gate: /healthz is open only to local probes, not to requests that came through Cloudflare', async () => {
  const gate = createCfAccessGate(verifier, true);
  assert.equal((await run(gate, '/healthz')).passed, true);
  assert.equal((await run(gate, '/healthz', { 'cf-ray': 'abc' })).passed, false);
  assert.equal((await run(gate, '/healthz', { 'cf-connecting-ip': '1.2.3.4' })).passed, false);
  assert.equal((await run(gate, '/api/projects')).passed, false, 'only /healthz is exempt');
});

test('gate: when not required it never blocks', async () => {
  assert.equal((await run(createCfAccessGate(null, false), '/api/projects')).passed, true);
});

test('websocket upgrades are held to the same requirement', async () => {
  const check = createCfAccessUpgradeCheck(verifier, true);
  assert.equal(await check({ headers: {} } as never), false);
  assert.equal(await check({ headers: { 'cf-access-jwt-assertion': await token() } } as never), true);
  assert.equal(await createCfAccessUpgradeCheck(null, false)({ headers: {} } as never), true);
});
