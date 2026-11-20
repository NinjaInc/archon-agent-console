import assert from 'node:assert/strict';
import test from 'node:test';

import { summariseTurnForNotification } from '../agy-chat.service.js';

const base = { steps: 3, minSeconds: 20 };

test('quick replies stay quiet and a turn you stopped never notifies', () => {
  assert.equal(summariseTurnForNotification({ ...base, status: 'SUCCESS', seconds: 4 }), null);
  assert.equal(summariseTurnForNotification({ ...base, status: 'STOPPED', seconds: 300 }), null);
});

test('a long reply notifies with its step count and duration', () => {
  assert.deepEqual(summariseTurnForNotification({ ...base, status: 'SUCCESS', seconds: 72 }), { kind: 'stop', reason: 'Reply ready (3 steps, 1m 12s)' });
  assert.deepEqual(summariseTurnForNotification({ ...base, steps: 1, status: 'SUCCESS', seconds: 30 }), { kind: 'stop', reason: 'Reply ready (1 step, 30s)' });
  assert.deepEqual(summariseTurnForNotification({ ...base, steps: 0, status: 'SUCCESS', seconds: 25 }), { kind: 'stop', reason: 'Reply ready (25s)' });
});

test('errors notify even when they are quick, and a denied command says what happened', () => {
  assert.deepEqual(summariseTurnForNotification({ ...base, status: 'ERROR', seconds: 2, error: 'Quota exceeded' }), { kind: 'error', message: 'Quota exceeded' });
  assert.equal(summariseTurnForNotification({ ...base, status: 'ERROR', seconds: 2 })?.kind, 'error');
  assert.deepEqual(summariseTurnForNotification({ ...base, status: 'DENIED', seconds: 40 }), { kind: 'stop', reason: 'Blocked: a command needed permission' });
});

test('an error message sent to a phone is bounded', () => {
  const result = summariseTurnForNotification({ ...base, status: 'ERROR', seconds: 1, error: 'x'.repeat(1000) });
  assert.equal(result?.kind === 'error' && result.message.length, 160);
});
