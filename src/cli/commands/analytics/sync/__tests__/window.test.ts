import { describe, expect, it } from 'vitest';

import { SyncConfigError } from '@/utils/errors.js';

import { backfillWindow, dailyWindow } from '../window.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('dailyWindow', () => {
  it('spans lookbackDays when there is no marker', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const window = dailyWindow(now, null, 7);

    expect(window.to).toEqual(now);
    expect(window.from).toEqual(new Date(now.getTime() - 7 * DAY_MS));
    expect(window.backfill).toBe(false);
  });

  it('spans lookbackDays when the marker is more recent than the lookback window', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const lastSent = new Date(now.getTime() - 2 * DAY_MS);
    const window = dailyWindow(now, lastSent, 7);

    expect(window.from).toEqual(new Date(now.getTime() - 7 * DAY_MS));
    expect(window.backfill).toBe(false);
  });

  it('spans marker age plus a 1 hour safety margin when the marker is older than the lookback window', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const lastSent = new Date(now.getTime() - 10 * DAY_MS);
    const window = dailyWindow(now, lastSent, 7);

    expect(window.from).toEqual(new Date(now.getTime() - 10 * DAY_MS - HOUR_MS));
    expect(window.backfill).toBe(false);
  });
});

describe('backfillWindow', () => {
  const now = new Date('2026-10-29T00:00:00.000Z');

  it('returns null when no flag is given', () => {
    expect(backfillWindow({}, now)).toBeNull();
  });

  it('throws SyncConfigError on an invalid --last value', () => {
    expect(() => backfillWindow({ last: 'abc' }, now)).toThrow(SyncConfigError);
  });

  it('throws SyncConfigError on an invalid --from value', () => {
    expect(() => backfillWindow({ from: 'not-a-date' }, now)).toThrow(SyncConfigError);
  });

  it('throws SyncConfigError on an invalid --to value', () => {
    expect(() => backfillWindow({ from: '2026-10-01', to: 'not-a-date' }, now)).toThrow(SyncConfigError);
  });

  it('builds a window from --from and --to with label YYYY-MM-DD-to-YYYY-MM-DD', () => {
    const window = backfillWindow({ from: '2026-10-01', to: '2026-10-05' }, now);

    expect(window).not.toBeNull();
    expect(window?.label).toBe('2026-10-01-to-2026-10-05');
    expect(window?.backfill).toBe(true);
    expect(window?.from).toEqual(new Date('2026-10-01'));
    expect(window?.to).toEqual(new Date('2026-10-05'));
  });

  it('defaults --to to now when only --from is given', () => {
    const window = backfillWindow({ from: '2026-10-01' }, now);

    expect(window).not.toBeNull();
    expect(window?.to).toEqual(now);
    expect(window?.backfill).toBe(true);
  });

  it('builds a window from --last as now minus the duration, to now', () => {
    const window = backfillWindow({ last: '3d' }, now);

    expect(window).not.toBeNull();
    expect(window?.from).toEqual(new Date(now.getTime() - 3 * DAY_MS));
    expect(window?.to).toEqual(now);
    expect(window?.backfill).toBe(true);
  });
});
