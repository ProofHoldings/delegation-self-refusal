import { describe, expect, it } from 'vitest';

import { MAX_GRACE_FAILURES, nextIntervalMs } from '../schedule.js';

describe('nextIntervalMs', () => {
  it('is never exactly the base interval (always jittered upward)', () => {
    for (let i = 0; i < 1000; i++) {
      expect(nextIntervalMs(60_000)).toBeGreaterThan(60_000);
    }
  });

  it('is never exactly :00-aligned (never a multiple of 60_000) with the default base', () => {
    for (let i = 0; i < 1000; i++) {
      expect(nextIntervalMs(60_000) % 60_000).not.toBe(0);
    }
  });

  it('stays within the documented jitter ceiling', () => {
    for (let i = 0; i < 1000; i++) {
      const value = nextIntervalMs(60_000);
      expect(value).toBeLessThanOrEqual(60_000 + 12_000);
    }
  });
});

describe('MAX_GRACE_FAILURES', () => {
  it('is a small hard-coded positive integer, not a runtime-configurable value', () => {
    expect(MAX_GRACE_FAILURES).toBeGreaterThan(0);
    expect(MAX_GRACE_FAILURES).toBeLessThanOrEqual(10);
    expect(Number.isInteger(MAX_GRACE_FAILURES)).toBe(true);
  });
});
