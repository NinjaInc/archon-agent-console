import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';

/**
 * The passkey session is an HttpOnly cookie, so the request helper must send no
 * credential header of its own, must let the browser attach the cookie, and
 * must tell the app when the server rejects the session.
 */

const loadFetch = async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  return (await import('@/shared/api')).authenticatedFetch;
};

let lastInit: RequestInit | undefined;

// The status matters as much as the headers: a cached response replays the
// headers it was stored with while surfacing its stored status.
const respondWith = (headers: Record<string, string> = {}, status = 200) => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    lastInit = init;
    return new Response('{}', { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const sentHeaders = () => (lastInit?.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  lastInit = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('no Authorization header is ever sent, even if an old token is left in storage', async () => {
  localStorage.setItem('auth-token', 'aaa.bbb.ccc');
  respondWith();

  await (await loadFetch())('/api/projects');

  assert.equal(sentHeaders().Authorization, undefined);
});

test('requests ask the browser to attach the same-origin session cookie and never cache', async () => {
  respondWith();

  await (await loadFetch())('/api/projects');

  assert.equal(lastInit?.credentials, 'same-origin');
  assert.equal(lastInit?.cache, 'no-store');
});

test('a real rejection (401 with X-Auth-Error) ends the session', async () => {
  respondWith({ 'X-Auth-Error': 'invalid-token' }, 401);
  const expired = vi.fn();
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);

  await (await loadFetch())('/api/projects');
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);

  assert.equal(expired.mock.calls.length, 1);
});

test('a 200 that merely carries X-Auth-Error (cached replay) does not end the session', async () => {
  respondWith({ 'X-Auth-Error': 'invalid-token' }, 200);
  const expired = vi.fn();
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);

  await (await loadFetch())('/api/projects');
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);

  assert.equal(expired.mock.calls.length, 0);
});
