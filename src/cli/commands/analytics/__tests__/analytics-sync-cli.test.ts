/**
 * CLI wiring tests for `codemie analytics sync` (EPMCDME-16554, Task 8; adapted for
 * EPMCDME-16488 Task 1).
 *
 * `sync config` (and the `applySyncUpdate`/`loadSyncConfig` config-store API it used) was
 * removed as part of moving sync state onto the collector-compatible store
 * (`sync/config-store.ts`, `sync/marker.ts`). A later task in the EPMCDME-16488 plan
 * rebuilds `sync` onto `install`/`status`/`run`/`uninstall`; for now this file only covers
 * what still exists: `sync` forwarding its backfill flags to `runSync`/`realSyncDeps`.
 *
 * Covers:
 *  - `sync` forwards --from/--to/--last to `runSync`/`realSyncDeps`, exit code is runSync's
 *    return value.
 *  - the parent's boolean `--include-external` and `analytics otel --file f --from <date>`
 *    still work (regression for `.enablePositionalOptions()`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runSyncMock = vi.fn();
const realSyncDepsMock = vi.fn();
vi.mock('../sync/run-sync.js', () => ({
  runSync: (...a: unknown[]) => runSyncMock(...a),
  realSyncDeps: (...a: unknown[]) => realSyncDepsMock(...a),
}));

const loadAnalyticsMock = vi.fn();
vi.mock('../analytics-core.js', () => ({
  loadAnalytics: (...a: unknown[]) => loadAnalyticsMock(...a),
}));

async function parse(argv: string[]) {
  const { createAnalyticsCommand } = await import('../index.js');
  const command = createAnalyticsCommand();
  // Swallow commander's own process.exit on parse errors (e.g. unknown option) so a
  // mis-wired test fails on an assertion instead of killing the test process.
  command.exitOverride();
  await command.parseAsync(argv, { from: 'user' });
  return command;
}

describe('analytics sync CLI wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realSyncDepsMock.mockReturnValue({ fake: 'deps' });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('forwards --from/--to/--last to runSync with realSyncDeps(), and sets exitCode from its result', async () => {
    runSyncMock.mockResolvedValue(0);
    await parse(['sync', '--from', '2026-10-01', '--to', '2026-10-15']);

    expect(runSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-10-01', to: '2026-10-15' }),
      { fake: 'deps' }
    );
    expect(process.exitCode).toBe(0);
  });

  it('forwards --last to runSync', async () => {
    runSyncMock.mockResolvedValue(1);
    await parse(['sync', '--last', '3d']);

    expect(runSyncMock).toHaveBeenCalledWith(expect.objectContaining({ last: '3d' }), { fake: 'deps' });
    expect(process.exitCode).toBe(1);
  });
});

describe('--include-external scoping across analytics / sync (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAnalyticsMock.mockResolvedValue({ kind: 'empty-raw' });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('"analytics otel --file f --from 2026-10-01" still receives --from', async () => {
    await parse(['otel', '--file', 'f', '--from', '2026-10-01']);

    expect(loadAnalyticsMock).toHaveBeenCalledTimes(1);
    const filter = loadAnalyticsMock.mock.calls[0][1];
    expect(filter.fromDate.toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('plain "analytics --include-external" still works', async () => {
    await parse(['--include-external']);

    expect(loadAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(loadAnalyticsMock.mock.calls[0][2]).toBe(true);
  });
});
