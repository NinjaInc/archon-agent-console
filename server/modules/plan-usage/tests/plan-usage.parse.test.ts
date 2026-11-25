import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgyUsage, parseClaudeUsage } from '../plan-usage.parse.js';

test('parses the agy report lines and skips junk', () => {
  const out = 'hello\nGemini Models\tFive Hour Limit Remaining\t32%\t2026-11-24T16:20:42Z\nA\tWeekly Limit Remaining\t140%\tx\nB\tWeekly Limit Remaining\t5%\tnot-a-date\n';
  assert.deepEqual(parseAgyUsage(out), [
    { provider: 'agy', family: 'Gemini Models', window: 'five-hour', remainingPercent: 32, resetsAt: '2026-11-24T16:20:42.000Z' },
    { provider: 'agy', family: 'B', window: 'weekly', remainingPercent: 5, resetsAt: null },
  ]);
});

test('parses the claude report, turning used into remaining', () => {
  const out = 'You are currently using your subscription\n\nCurrent session: 4% used · resets Nov 25, 8:39am (UTC)\nCurrent week (all models): 10% used · resets Dec 1, 9pm (UTC)\nCurrent week (Opus): 0% used\n  76%  Start fresh';
  assert.deepEqual(parseClaudeUsage(out, Date.parse('2026-11-25T05:00:00Z')), [
    { provider: 'claude', family: 'Claude', window: 'five-hour', remainingPercent: 96, resetsAt: '2026-11-25T08:39:00.000Z' },
    { provider: 'claude', family: 'Claude', window: 'weekly', remainingPercent: 90, resetsAt: '2026-12-01T21:00:00.000Z' },
    { provider: 'claude', family: 'Claude (Opus)', window: 'weekly', remainingPercent: 100, resetsAt: null },
  ]);
});

test('a reset in January seen in December is next year; other time zones give no date', () => {
  const line = (reset: string) => `Current session: 1% used · resets ${reset}`;
  assert.equal(parseClaudeUsage(line('Jan 1, 2am (UTC)'), Date.parse('2026-12-31T23:00:00Z'))[0].resetsAt, '2027-01-01T02:00:00.000Z');
  assert.equal(parseClaudeUsage(line('Jan 1, 2am (Australia/Perth)'))[0].resetsAt, null);
});
