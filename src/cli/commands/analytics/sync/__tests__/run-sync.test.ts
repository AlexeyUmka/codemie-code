import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { SyncDeliveryError, SyncIdentityMissingError } from '@/utils/errors.js';

import { runSync } from '../run-sync.js';
import type { SyncDeps } from '../run-sync.js';
import type { SyncConfig, SyncReport, SyncTarget } from '../types.js';
import type { AnalyticsSource } from '../../sources/types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const NOW = new Date('2026-10-29T00:00:00.000Z');
const REPORT: SyncReport = { fileName: 'report.json', bytes: Buffer.from('{"a":1}') };

const BASE_CONFIG: SyncConfig = {
  targets: { webhook: { url: 'https://example.invalid/hook?sig=FAKE' } },
  includeExternal: 'windows',
  lookbackDays: 7,
};

function fakeTarget(id: string, deliver: (report: SyncReport) => Promise<void>): SyncTarget {
  return { id, type: 'webhook', deliver };
}

/** Real temp dir/removal so the (non-injected) report write in `runSync` lands somewhere real. */
async function realMakeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'run-sync-test-'));
}

async function realRemoveDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

interface Harness {
  deps: SyncDeps;
  printed: string[];
  logged: string[];
}

function makeDeps(overrides: Partial<SyncDeps> = {}): Harness {
  const printed: string[] = [];
  const logged: string[] = [];

  const deps: SyncDeps = {
    now: () => NOW,
    loadConfig: async () => BASE_CONFIG,
    resolveIdentity: async () => 'dev@example.invalid',
    createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', async () => {})] : []),
    buildReport: async () => REPORT,
    readMarker: async () => null,
    writeMarker: async () => {},
    appendLog: async (line: string): Promise<void> => {
      logged.push(line);
    },
    print: (line: string): void => {
      printed.push(line);
    },
    platform: 'linux',
    source: {} as AnalyticsSource,
    makeTempDir: realMakeTempDir,
    removeDir: realRemoveDir,
    ...overrides,
  };

  return { deps, printed, logged };
}

describe('runSync', () => {
  it('AC2: a daily run reads the marker for the window and stamps it at the run start now only after deliver resolves', async () => {
    const lastSent = new Date(NOW.getTime() - 10 * DAY_MS);
    const readMarker = vi.fn(async () => lastSent);
    const writeMarker = vi.fn(async () => {});
    const buildReport = vi.fn(async () => REPORT);
    const deliver = vi.fn(async () => {});

    const { deps } = makeDeps({
      readMarker,
      writeMarker,
      buildReport,
      createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', deliver)] : []),
    });

    const code = await runSync({}, deps);

    expect(code).toBe(0);
    expect(readMarker).toHaveBeenCalledWith('webhook', NOW);

    const passedWindow = buildReport.mock.calls[0]?.[0]?.window;
    expect(passedWindow.to).toEqual(NOW);
    expect(passedWindow.from).toEqual(new Date(NOW.getTime() - (10 * DAY_MS + HOUR_MS)));
    expect(passedWindow.backfill).toBe(false);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(writeMarker).toHaveBeenCalledWith('webhook', NOW);
  });

  it('AC3: a failing delivery returns 1, leaves the marker unchanged, and still removes the temp dir', async () => {
    const writeMarker = vi.fn(async () => {});
    const removeDir = vi.fn(realRemoveDir);
    const deliver = vi.fn(async () => {
      throw new SyncDeliveryError('Webhook delivery failed with status 500');
    });

    const { deps, printed, logged } = makeDeps({
      writeMarker,
      removeDir,
      createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', deliver)] : []),
    });

    const code = await runSync({}, deps);

    expect(code).toBe(1);
    expect(writeMarker).not.toHaveBeenCalled();
    expect(removeDir).toHaveBeenCalledTimes(1);
    expect(printed.some((line) => line.startsWith('fail webhook'))).toBe(true);
    expect(logged.some((line) => line.startsWith('fail webhook'))).toBe(true);
  });

  it('AC4: no sessions in the window skips delivery, leaves the marker unchanged, and exits 0', async () => {
    const deliver = vi.fn(async () => {});
    const writeMarker = vi.fn(async () => {});
    const buildReport = vi.fn(async () => null);

    const { deps, printed, logged } = makeDeps({
      buildReport,
      writeMarker,
      createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', deliver)] : []),
    });

    const code = await runSync({}, deps);

    expect(code).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(printed.some((line) => line.startsWith('skip webhook'))).toBe(true);
    expect(logged.some((line) => line.startsWith('skip webhook'))).toBe(true);
  });

  it('AC5: no resolvable email fails without building a report and names --email', async () => {
    const buildReport = vi.fn(async () => REPORT);

    const { deps, printed, logged } = makeDeps({
      resolveIdentity: async () => {
        throw new SyncIdentityMissingError();
      },
      buildReport,
    });

    const code = await runSync({}, deps);

    expect(code).toBe(1);
    expect(buildReport).not.toHaveBeenCalled();
    expect(printed.some((line) => line.includes('--email'))).toBe(true);
    expect(logged.some((line) => line.includes('--email'))).toBe(true);
  });

  it('AC6: a backfill (--last) never reads or writes any marker', async () => {
    const readMarker = vi.fn(async () => null);
    const writeMarker = vi.fn(async () => {});
    const deliver = vi.fn(async () => {});

    const { deps } = makeDeps({
      readMarker,
      writeMarker,
      createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', deliver)] : []),
    });

    const code = await runSync({ last: '30d' }, deps);

    expect(code).toBe(0);
    expect(readMarker).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('AC7: no configured target fails and names --webhook-url', async () => {
    const { deps, printed, logged } = makeDeps({
      createTargets: () => [],
    });

    const code = await runSync({}, deps);

    expect(code).toBe(1);
    expect(printed.some((line) => line.includes('--webhook-url'))).toBe(true);
    expect(logged.some((line) => line.includes('--webhook-url'))).toBe(true);
  });

  it('AC8: a delivery error carrying a signed URL never leaks sig into printed or logged lines', async () => {
    const deliver = vi.fn(async () => {
      throw new SyncDeliveryError('Webhook delivery failed for https://example.invalid/hook?sig=FAKESIG');
    });

    const { deps, printed, logged } = makeDeps({
      createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', deliver)] : []),
    });

    const code = await runSync({}, deps);

    expect(code).toBe(1);
    expect(printed.some((line) => line.includes('FAKESIG'))).toBe(false);
    expect(logged.some((line) => line.includes('FAKESIG'))).toBe(false);
  });

  it('removes the temp dir in a finally even when delivery throws', async () => {
    const removeDir = vi.fn(realRemoveDir);
    const deliver = vi.fn(async () => {
      throw new Error('boom');
    });

    const { deps } = makeDeps({
      removeDir,
      createTargets: (cfg) => (cfg.targets.webhook ? [fakeTarget('webhook', deliver)] : []),
    });

    await runSync({}, deps);

    expect(removeDir).toHaveBeenCalledTimes(1);
  });

  it('no configured target returns 1 without creating or removing a temp dir', async () => {
    const makeTempDir = vi.fn(realMakeTempDir);
    const removeDir = vi.fn(realRemoveDir);

    const { deps } = makeDeps({
      createTargets: () => [],
      makeTempDir,
      removeDir,
    });

    const code = await runSync({}, deps);

    expect(code).toBe(1);
    expect(makeTempDir).not.toHaveBeenCalled();
    expect(removeDir).not.toHaveBeenCalled();
  });
});
