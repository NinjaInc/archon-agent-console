import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';

import { createGpuArbiter } from '../gpu-arbiter.service.js';

function make(external: () => Promise<{ externalBusy: boolean } | null>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-'));
  let clock = 1_000_000;
  const arbiter = createGpuArbiter({ path: path.join(dir, 'a.db'), external, now: () => clock, ttlMs: 90_000 });
  return { arbiter, tick: (ms: number) => { clock += ms; } };
}
const idle = async () => ({ externalBusy: false });

test('llm leases share, an image lease is exclusive', async () => {
  const { arbiter } = make(idle);
  const a = await arbiter.acquire({ holder: 'chat', kind: 'llm', priority: 'interactive' });
  const b = await arbiter.acquire({ holder: 'search', kind: 'llm', priority: 'interactive' });
  assert.equal(a.ok && b.ok, true);
  const img = await arbiter.acquire({ holder: 'img', kind: 'image', priority: 'interactive' });
  assert.deepEqual(img, { ok: false, reason: 'held' });
  assert.equal(arbiter.state().state, 'llm');
});

test('interactive preempts nightly; the nightly heartbeat then fails', async () => {
  const { arbiter } = make(idle);
  const night = await arbiter.acquire({ holder: 'nightly', kind: 'llm', priority: 'nightly' });
  assert.equal(night.ok, true);
  const img = await arbiter.acquire({ holder: 'img', kind: 'image', priority: 'interactive' });
  assert.equal(img.ok, true);
  if (night.ok) assert.equal(arbiter.heartbeat(night.lease.id), false);
});

test('nightly never preempts and never preempts interactive', async () => {
  const { arbiter } = make(idle);
  await arbiter.acquire({ holder: 'chat', kind: 'llm', priority: 'interactive' });
  const night = await arbiter.acquire({ holder: 'nightly', kind: 'image', priority: 'nightly' });
  assert.deepEqual(night, { ok: false, reason: 'held' });
});

test('a game (external GPU use) blocks both nightly and interactive', async () => {
  const { arbiter } = make(async () => ({ externalBusy: true }));
  assert.deepEqual(await arbiter.acquire({ holder: 'n', kind: 'llm', priority: 'nightly' }), { ok: false, reason: 'busy-external' });
  assert.deepEqual(await arbiter.acquire({ holder: 'i', kind: 'llm', priority: 'interactive' }), { ok: false, reason: 'busy-external' });
});

test('unreachable desktop: nightly fails closed, interactive fails open', async () => {
  const { arbiter } = make(async () => null);
  assert.deepEqual(await arbiter.acquire({ holder: 'n', kind: 'llm', priority: 'nightly' }), { ok: false, reason: 'desktop-unreachable' });
  assert.equal((await arbiter.acquire({ holder: 'i', kind: 'llm', priority: 'interactive' })).ok, true);
});

test('a crashed holder frees the GPU when its lease expires; heartbeat extends it; release is idempotent', async () => {
  const { arbiter, tick } = make(idle);
  const a = await arbiter.acquire({ holder: 'img', kind: 'image', priority: 'interactive' });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  tick(60_000);
  assert.equal(arbiter.heartbeat(a.lease.id), true);
  tick(60_000);
  assert.equal(arbiter.state().state, 'image');
  tick(60_000);
  assert.equal(arbiter.state().state, 'idle');
  assert.equal(arbiter.heartbeat(a.lease.id), false);
  arbiter.release(a.lease.id);
  arbiter.release(a.lease.id);
});

test('an external check that throws counts as unreachable', async () => {
  const { arbiter } = make(async () => { throw new Error('down'); });
  assert.equal((await arbiter.acquire({ holder: 'n', kind: 'llm', priority: 'nightly' })).ok, false);
});
