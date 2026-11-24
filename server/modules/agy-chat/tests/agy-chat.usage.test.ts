import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgyUsage } from '../agy-chat.usage.js';

test('parses the four report lines', () => {
  const out = 'Gemini Models\tWeekly Limit Remaining\t83%\t2026-12-01T11:20:42Z\nGemini Models\tFive Hour Limit Remaining\t32%\t2026-11-24T16:20:42Z\nClaude and GPT models\tWeekly Limit Remaining\t20%\t2026-11-25T02:35:36Z\n';
  const limits = parseAgyUsage(out);
  assert.equal(limits.length, 3);
  assert.deepEqual(limits[1], { family: 'Gemini Models', window: 'five-hour', remainingPercent: 32, resetsAt: '2026-11-24T16:20:42.000Z' });
});

test('skips junk, impossible percentages and bad dates', () => {
  const limits = parseAgyUsage('hello\nA\tWeekly Limit Remaining\t140%\tx\nB\tWeekly Limit Remaining\t5%\tnot-a-date\n\t\t\t');
  assert.deepEqual(limits, [{ family: 'B', window: 'weekly', remainingPercent: 5, resetsAt: null }]);
});
