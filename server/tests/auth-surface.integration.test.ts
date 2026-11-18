import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { VirtualAuthenticator } from '../modules/auth/tests/virtual-authenticator.js';

/**
 * Boots the REAL server (own database, own HOME) and checks, over real HTTP and
 * websockets, that nothing sensitive is reachable without a passkey session.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-surface-'));
const freePort = await new Promise<number>((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});
const ORIGIN = `http://localhost:${freePort}`;
const BASE = `http://127.0.0.1:${freePort}`;

let server: ChildProcess;
let bootstrapToken = '';
let output = '';

test.before(async () => {
  fs.mkdirSync(path.join(sandbox, 'home', 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'home', 'projects', 'demo', 'hello.txt'), 'hi');
  server = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: path.join(sandbox, 'home'),
      DATABASE_PATH: path.join(sandbox, 'auth.db'),
      SERVER_PORT: String(freePort),
      HOST: '127.0.0.1',
      APP_ORIGIN: ORIGIN,
      RP_ID: 'localhost',
      WORKSPACES_ROOT: path.join(sandbox, 'home', 'projects'),
      BOOTSTRAP_TOKEN: '',
      VITE_IS_PLATFORM: 'false',
    },
    // Own process group so the whole npx -> tsx -> node tree can be killed together.
    detached: true,
  });
  server.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr?.on('data', (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const match = output.match(/^\s{4}(\S{40,})\s*$/m);
  assert.ok(match, `server must print a bootstrap token on first run.\n${output.slice(-800)}`);
  bootstrapToken = match[1];
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const json = (body: unknown) => JSON.stringify(body);
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: json(body) });

function wsOutcome(url: string, headers: Record<string, string>): Promise<'open' | number | 'error'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${freePort}${url}`, { headers });
    socket.on('open', () => { socket.close(); resolve('open'); });
    socket.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 'error'); });
    socket.on('error', () => resolve('error'));
  });
}

const PROTECTED_GETS = [
  '/api/file-tree/anything', '/api/projects', '/api/git/status', '/api/settings/api-keys', '/api/agy/status',
  '/api/providers/sessions/recent', '/api/system/version', '/api/plugins', '/api/user/git-config',
  '/api/notifications/vapid-public-key', '/api/worktrees', '/api/taskmaster/installation-status',
  '/api/commands/list', '/api/assets/x', '/api/browser-use/status', '/api/scheduled-messages', '/api/voice/status',
  '/api/auth/user', '/api/auth/passkeys', '/api/agent',
];

test('without a session every protected API route answers 401', async () => {
  for (const route of PROTECTED_GETS) {
    const response = await fetch(`${BASE}${route}`, { headers: { origin: ORIGIN } });
    assert.equal(response.status, 401, `${route} must require a session (got ${response.status})`);
  }
});

test('without a session the shell, chat and other websockets refuse the upgrade', async () => {
  for (const wsPath of ['/shell', '/ws', '/desktop-notifications', '/plugin-ws/demo']) {
    assert.equal(await wsOutcome(wsPath, { origin: ORIGIN }), 401, `${wsPath} must be refused without a cookie`);
  }
});

test('writes with a foreign or missing Origin are rejected before auth', async () => {
  for (const origin of ['https://evil.example', undefined]) {
    const response = await fetch(`${BASE}/api/projects/create-workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: '{}',
    });
    assert.equal(response.status, 403);
  }
});

test('CORS is not opened to other origins', async () => {
  const response = await fetch(`${BASE}/api/auth/status`, { headers: { origin: 'https://evil.example' } });
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  assert.notEqual(response.headers.get('access-control-allow-origin'), 'https://evil.example');
});

test('legacy password endpoints and ?token= no longer exist', async () => {
  for (const route of ['/api/auth/login', '/api/auth/register']) {
    const response = await post(route, { username: 'a', password: 'b' });
    assert.ok([404, 405].includes(response.status) || response.status === 429, `${route} -> ${response.status}`);
  }
  assert.equal(await wsOutcome('/shell?token=anything', { origin: ORIGIN }), 401);
});

test('passkey registration over HTTP sets a hardened cookie that unlocks the API and shell websocket', async () => {
  assert.deepEqual(await (await fetch(`${BASE}/api/auth/status`)).json(), { needsSetup: true, isAuthenticated: false });

  // Wrong token is refused.
  assert.equal((await post('/api/auth/register/options', { bootstrapToken: 'z'.repeat(43) })).status, 401);

  const authenticator = new VirtualAuthenticator('localhost', ORIGIN);
  const begin = await (await post('/api/auth/register/options', { bootstrapToken })).json() as { challengeId: string; options: { challenge: string } };
  const verify = await post('/api/auth/register/verify', {
    challengeId: begin.challengeId,
    bootstrapToken,
    name: 'Test key',
    response: authenticator.register(begin.options.challenge),
  });
  assert.equal(verify.status, 200);

  const setCookie = verify.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^__Host-archon_session=[A-Za-z0-9_-]{40,}/);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
    assert.ok(setCookie.includes(attribute), `cookie must carry ${attribute}: ${setCookie}`);
  }
  assert.ok(!/domain=/i.test(setCookie), '__Host- cookies must not set Domain');
  const cookie = setCookie.split(';')[0];

  assert.equal((await fetch(`${BASE}/api/auth/user`, { headers: { cookie, origin: ORIGIN } })).status, 200);
  const files = await fetch(`${BASE}/api/projects`, { headers: { cookie } });
  assert.equal(files.status, 200);

  assert.equal(await wsOutcome('/shell', { origin: ORIGIN, cookie }), 'open');
  assert.notEqual(await wsOutcome('/shell', { origin: 'https://evil.example', cookie }), 'open', 'cross-site websocket hijack must fail even with a valid cookie');
  assert.notEqual(await wsOutcome('/shell', { cookie }), 'open', 'a websocket with no Origin must fail');

  // Registration is closed to bootstrap tokens now.
  assert.equal((await post('/api/auth/register/options', { bootstrapToken })).status, 401);

  // Logout revokes server-side.
  assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 200);
  assert.equal((await fetch(`${BASE}/api/auth/user`, { headers: { cookie } })).status, 401);
  assert.equal(await wsOutcome('/shell', { origin: ORIGIN, cookie }), 401);

  // Login with the passkey works again.
  const loginBegin = await (await post('/api/auth/login/options', {})).json() as { challengeId: string; options: { challenge: string } };
  const login = await post('/api/auth/login/verify', { challengeId: loginBegin.challengeId, response: authenticator.assert(loginBegin.options.challenge) });
  assert.equal(login.status, 200);
});

test('auth endpoints are rate limited', async () => {
  let limited = false;
  for (let attempt = 0; attempt < 30 && !limited; attempt += 1) {
    limited = (await post('/api/auth/login/verify', { challengeId: 'x', response: {} })).status === 429;
  }
  assert.ok(limited, 'repeated login attempts must hit 429');
});
