/**
 * CLI wiring tests for `codemie analytics sync` and `codemie analytics sync config`
 * (EPMCDME-16554, Task 8).
 *
 * Covers:
 *  - `sync` forwards --from/--to/--last to `runSync`/`realSyncDeps`, exit code is runSync's
 *    return value.
 *  - `sync config` forwards flag values to `applySyncUpdate`.
 *  - `sync config --email` validates with the same regex as the interactive prompt before
 *    anything is saved; an invalid email saves nothing and sets exitCode 1.
 *  - the parent's boolean `--include-external` does not swallow `sync config
 *    --include-external <mode>`'s value, and `analytics otel --file f --from <date>` and
 *    plain `analytics --include-external` still work.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const applySyncUpdateMock = vi.fn();
const loadSyncConfigMock = vi.fn();
vi.mock('../sync/config-store.js', () => ({
  applySyncUpdate: (...a: unknown[]) => applySyncUpdateMock(...a),
  loadSyncConfig: (...a: unknown[]) => loadSyncConfigMock(...a),
}));

const runSyncMock = vi.fn();
const realSyncDepsMock = vi.fn();
vi.mock('../sync/run-sync.js', () => ({
  runSync: (...a: unknown[]) => runSyncMock(...a),
  realSyncDeps: (...a: unknown[]) => realSyncDepsMock(...a),
}));

const saveUserEmailMock = vi.fn();
vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    saveUserEmail: (...a: unknown[]) => saveUserEmailMock(...a),
    loadMultiProviderConfig: vi.fn().mockResolvedValue({ userEmail: undefined }),
  },
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

describe('analytics sync config CLI wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applySyncUpdateMock.mockResolvedValue({
      targets: {},
      includeExternal: 'windows',
      lookbackDays: 7,
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('passes includeExternal and lookbackDays through to applySyncUpdate', async () => {
    await parse(['sync', 'config', '--include-external', 'always', '--lookback-days', '14']);

    expect(applySyncUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeExternal: 'always', lookbackDays: '14' })
    );
    expect(saveUserEmailMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('passes webhookUrl through to applySyncUpdate', async () => {
    await parse(['sync', 'config', '--webhook-url', 'https://example.invalid/hook?sig=FAKE']);

    expect(applySyncUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: 'https://example.invalid/hook?sig=FAKE' })
    );
  });

  it('saves a valid --email via ConfigLoader.saveUserEmail, after applySyncUpdate', async () => {
    await parse(['sync', 'config', '--email', 'dev@example.com']);

    expect(applySyncUpdateMock).toHaveBeenCalled();
    expect(saveUserEmailMock).toHaveBeenCalledWith('dev@example.com');
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects an invalid --email, saving nothing and setting exitCode 1', async () => {
    await parse(['sync', 'config', '--email', 'not-an-email', '--lookback-days', '14']);

    expect(applySyncUpdateMock).not.toHaveBeenCalled();
    expect(saveUserEmailMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('prints the redacted message and sets exitCode 1 when applySyncUpdate throws a CodeMieError', async () => {
    const { SyncConfigError } = await import('../../../../utils/errors.js');
    applySyncUpdateMock.mockRejectedValue(new SyncConfigError('Webhook URL must use https: https://x?sig=secret-token'));
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await parse(['sync', 'config', '--webhook-url', 'http://example.invalid']);

      expect(process.exitCode).toBe(1);
      const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).toContain('sig=REDACTED');
      expect(printed).not.toContain('secret-token');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints the current effective config (redacting the webhook URL) when no flags are given', async () => {
    loadSyncConfigMock.mockResolvedValue({
      targets: { webhook: { url: 'https://example.invalid/hook?sig=FAKE' } },
      includeExternal: 'windows',
      lookbackDays: 7,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await parse(['sync', 'config']);

      expect(applySyncUpdateMock).not.toHaveBeenCalled();
      const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).toContain('sig=REDACTED');
      expect(printed).not.toContain('sig=FAKE');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('--include-external scoping across analytics / sync / config (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applySyncUpdateMock.mockResolvedValue({ targets: {}, includeExternal: 'windows', lookbackDays: 7 });
    loadAnalyticsMock.mockResolvedValue({ kind: 'empty-raw' });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('"sync config --include-external always" reaches config, not the parent boolean flag', async () => {
    await parse(['sync', 'config', '--include-external', 'always']);
    expect(applySyncUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ includeExternal: 'always' }));
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
