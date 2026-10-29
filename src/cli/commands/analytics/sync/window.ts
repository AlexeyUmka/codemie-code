/**
 * Date windows for `codemie analytics sync`.
 *
 * `dailyWindow` builds the recurring day-to-day sync window from the last-sent marker.
 * `backfillWindow` mirrors how the interactive `analytics` command turns `--from`/`--to`/
 * `--last` into a date range (see `parseFilterOptions` in `../index.ts`), except that an
 * invalid value throws `SyncConfigError` instead of being silently ignored.
 */

import { SyncConfigError } from '@/utils/errors.js';

import { parseDate, parseDuration } from '../date-args.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SyncWindow {
  from: Date;
  to: Date;
  backfill: boolean;
  label: string;
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dailyLabel(from: Date, to: Date): string {
  return `${formatUtcDate(from)}-to-${formatUtcDate(to)}`;
}

/**
 * Build the recurring daily sync window.
 *
 * `from = now - max(lookbackDays·24h, (now - lastSent) + 1h safety margin)`. With no
 * marker (`lastSent === null`), the window is exactly `lookbackDays` wide.
 */
export function dailyWindow(now: Date, lastSent: Date | null, lookbackDays: number): SyncWindow {
  const lookbackMs = lookbackDays * DAY_MS;
  const spanMs =
    lastSent === null ? lookbackMs : Math.max(lookbackMs, now.getTime() - lastSent.getTime() + HOUR_MS);

  const from = new Date(now.getTime() - spanMs);
  const to = now;

  return {
    from,
    to,
    backfill: false,
    label: dailyLabel(from, to)
  };
}

/** Raw `--from`/`--to`/`--last` flags as given on the CLI. */
export interface BackfillWindowOptions {
  from?: string;
  to?: string;
  last?: string;
}

/**
 * Build a one-off backfill window from `--from`/`--to`/`--last`.
 *
 * Returns `null` when none of the three flags is given. Throws `SyncConfigError` on any
 * invalid value (unlike the interactive command, which ignores invalid filters). When only
 * `--from` is given, `to` defaults to `now`. `--last` takes precedence over `--from`/`--to`,
 * same as the interactive command's filter building.
 */
export function backfillWindow(opts: BackfillWindowOptions, now: Date): SyncWindow | null {
  if (opts.from === undefined && opts.to === undefined && opts.last === undefined) {
    return null;
  }

  let from: Date | undefined;
  let to: Date | undefined;

  if (opts.from !== undefined) {
    const parsed = parseDate(opts.from);
    if (!parsed) {
      throw new SyncConfigError(`Invalid --from date "${opts.from}". Expected YYYY-MM-DD.`);
    }
    from = parsed;
  }

  if (opts.to !== undefined) {
    const parsed = parseDate(opts.to);
    if (!parsed) {
      throw new SyncConfigError(`Invalid --to date "${opts.to}". Expected YYYY-MM-DD.`);
    }
    to = parsed;
  }

  if (opts.last !== undefined) {
    const duration = parseDuration(opts.last);
    if (duration === null) {
      throw new SyncConfigError(`Invalid --last duration "${opts.last}". Expected e.g. "7d" or "24h".`);
    }
    from = new Date(now.getTime() - duration);
    to = now;
  }

  if (to === undefined) {
    to = now;
  }

  if (from === undefined) {
    throw new SyncConfigError('Backfill requires --from or --last.');
  }

  return {
    from,
    to,
    backfill: true,
    label: dailyLabel(from, to)
  };
}
