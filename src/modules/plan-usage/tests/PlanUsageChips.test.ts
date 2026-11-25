import { describe, expect, it } from 'vitest';

import { formatReset } from '@/modules/plan-usage/PlanUsageChips';

describe('formatReset', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  it('formats minutes, hours and days', () => {
    expect(formatReset('2026-11-24T12:40:00Z', now)).toBe('in 40m');
    expect(formatReset('2026-11-24T15:20:00Z', now)).toBe('in 3h 20m');
    expect(formatReset('2026-12-01T12:00:00Z', now)).toBe('in 7d');
  });
  it('is blank when unknown and never negative', () => {
    expect(formatReset(null, now)).toBe('');
    expect(formatReset('2026-11-24T11:00:00Z', now)).toBe('in 0m');
  });
});
