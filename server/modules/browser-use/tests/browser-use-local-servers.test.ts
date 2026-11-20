import assert from 'node:assert/strict';
import test from 'node:test';

import { parseListeningServers } from '../browser-use-local-servers.js';

// Trimmed from `ss -H -ltnp` on the dev server: the console, a Vite server, a python http.server, noise.
const SAMPLE = `
LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=5111,fd=19))
LISTEN 0 511 [::1]:5173 [::]:* users:(("node",pid=5111,fd=20))
LISTEN 0 5 0.0.0.0:8000 0.0.0.0:* users:(("python3",pid=5222,fd=3))
LISTEN 0 511 10.0.0.5:3001 0.0.0.0:* users:(("node-MainThread",pid=415487,fd=22))
LISTEN 0 4096 127.0.0.1:37429 0.0.0.0:* users:(("agy",pid=416391,fd=11))
LISTEN 0 4096 127.0.0.1:36987 0.0.0.0:* users:(("node-MainThread",pid=417731,fd=21))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
LISTEN 0 128 127.0.0.1:3306 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:20241 0.0.0.0:* users:(("cloudflared",pid=1,fd=3))
LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*
LISTEN 0 511 10.0.0.5:4321 0.0.0.0:* users:(("node",pid=5333,fd=12))
`;

test('finds this user\'s dev servers and hides the console, helpers and other users\' services', () => {
  const servers = parseListeningServers(SAMPLE, 3001);
  assert.deepEqual(servers.map((s) => [s.port, s.host, s.process]), [
    [4321, '10.0.0.5', 'node'],
    [5173, '127.0.0.1', 'node'],
    [8000, '127.0.0.1', 'python3'],
  ]);
  assert.equal(servers.find((s) => s.port === 5173)!.pid, 5111);
});

test('an IPv4 and IPv6 listener on the same port is one entry, and wildcard binds open on loopback', () => {
  assert.equal(parseListeningServers(SAMPLE, 3001).filter((s) => s.port === 5173).length, 1);
  assert.equal(parseListeningServers(SAMPLE, 3001).find((s) => s.port === 8000)!.host, '127.0.0.1');
});

test('garbage and empty output are harmless', () => {
  assert.deepEqual(parseListeningServers('', 3001), []);
  assert.deepEqual(parseListeningServers('LISTEN\nnot a line\nLISTEN 0 1 x y z', 3001), []);
});
