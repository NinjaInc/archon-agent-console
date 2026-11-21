import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

import { buildNotificationPayload, createNotificationEvent } from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-notification-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('an Antigravity notification names the provider and tells the app which tab to open', async () => {
  await withIsolatedDatabase(() => {
    const payload = buildNotificationPayload(createNotificationEvent({
      provider: 'agy',
      sessionId: '63024ac9-9a90-442b-9f92-afd54afb6a25',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'Reply ready (4 steps, 1m 12s)', sessionName: 'aurora-site · Review the site', tab: 'agy-chat' },
    }));
    assert.equal(payload.title, 'aurora-site · Review the site');
    assert.equal(payload.body, 'Antigravity: Reply ready (4 steps, 1m 12s)');
    assert.equal(payload.data.tab, 'agy-chat');
    assert.equal(payload.data.provider, 'agy');
  });
});

test('a notification with no session name falls back to the console name, not the upstream one', async () => {
  await withIsolatedDatabase(() => {
    const payload = buildNotificationPayload(createNotificationEvent({ provider: 'agy', code: 'run.stopped', kind: 'stop', meta: {} }));
    assert.equal(payload.title, 'Archon Agent Console');
  });
});
