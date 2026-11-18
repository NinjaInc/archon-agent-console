import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-access-'));
const children: ChildProcess[] = [];

const freePort = () => new Promise<number>((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});

function start(env: Record<string, string>) {
  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: path.join(sandbox, 'home'), DATABASE_PATH: path.join(sandbox, `${Math.random()}.db`), HOST: '127.0.0.1', VITE_IS_PLATFORM: 'false', ...env },
    detached: true,
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function waitForHealth(base: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/healthz`)).ok) return true; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

test.after(() => {
  for (const child of children) {
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('with CF_ACCESS_REQUIRED the server serves nothing without a valid Access assertion', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = start({
    SERVER_PORT: String(port), APP_ORIGIN: `http://localhost:${port}`, RP_ID: 'localhost',
    CF_ACCESS_REQUIRED: 'true', CF_ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-1234',
  });
  assert.ok(await waitForHealth(base), `server did not start:\n${server.output().slice(-600)}`);

  for (const route of ['/', '/index.html', '/api/auth/status', '/health', '/assets/x.js']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 403, `${route} must require Access`);
  }
  assert.equal((await fetch(`${base}/api/auth/status`, { headers: { 'cf-access-jwt-assertion': 'not.a.jwt' } })).status, 403);

  // Local probe is fine; the same request arriving through Cloudflare is not.
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`, { headers: { 'cf-ray': 'abc123' } })).status, 403);

  const upgrade = await new Promise<number | 'open'>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/shell`, { headers: { origin: `http://localhost:${port}` } });
    socket.on('open', () => { socket.close(); resolve('open'); });
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('error', () => resolve(0));
  });
  assert.equal(upgrade, 401, 'websocket upgrade without an assertion must be refused');
});

test('CF_ACCESS_REQUIRED with no team domain or audience refuses to start (fails closed)', async () => {
  const port = await freePort();
  const server = start({ SERVER_PORT: String(port), CF_ACCESS_REQUIRED: 'true' });
  const code = await Promise.race([server.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 45_000))]);
  assert.notEqual(code, 'timeout', 'server must exit, not run unprotected');
  assert.notEqual(code, 0);
});

test('the server refuses to bind to anything but loopback', async () => {
  const port = await freePort();
  const server = start({ SERVER_PORT: String(port), HOST: '0.0.0.0' });
  const code = await Promise.race([server.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 45_000))]);
  assert.notEqual(code, 'timeout');
  assert.equal(code, 1);
  assert.match(server.output(), /not a loopback address/);
});
