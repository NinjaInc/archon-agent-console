import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlanUsageService } from '../plan-usage.service.js';

test('one failing provider does not hide the other, and calls are cached for a minute', async () => {
  let runs = 0;
  let clock = 0;
  const service = createPlanUsageService({
    runClaude: async () => { runs += 1; return 'Current session: 4% used'; },
    runAgy: async () => { throw new Error('offline'); },
    now: () => clock,
  });
  const [first, second] = await Promise.all([service.list(), service.list()]);
  assert.equal(first.length, 1);
  assert.deepEqual(first, second);
  assert.equal(runs, 1);
  clock = 61_000;
  await service.list();
  assert.equal(runs, 2);
});
