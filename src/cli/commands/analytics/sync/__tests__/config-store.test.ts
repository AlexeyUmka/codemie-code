import { chmod, mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncConfigError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import { applySyncUpdate, getSyncConfigPath, loadSyncConfig, validateSyncUpdate } from '../config-store.js';

const FAKE_URL = 'https://example.invalid/webhook?sig=FAKE';

describe('getSyncConfigPath', () => {
  it('points at analytics/sync/config.json under the CodeMie home', () => {
    expect(getSyncConfigPath()).toBe(getCodemiePath('analytics', 'sync', 'config.json'));
  });
});

describe('config-store', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-sync-config-'));
    configPath = join(dir, 'config.json');
  });

  afterEach(() => {
    delete process.env.ANALYTICS_WEBHOOK_URL;
  });

  describe('loadSyncConfig', () => {
    it('returns defaults with empty targets when the file is missing', async () => {
      const config = await loadSyncConfig(configPath);
      expect(config).toEqual({ targets: {}, includeExternal: 'windows', lookbackDays: 7 });
    });

    it('throws SyncConfigError on malformed JSON', async () => {
      await writeFile(configPath, '{not valid json', 'utf-8');
      await expect(loadSyncConfig(configPath)).rejects.toThrow(SyncConfigError);
    });

    it('never reads ANALYTICS_WEBHOOK_URL: a missing file still has no target', async () => {
      process.env.ANALYTICS_WEBHOOK_URL = FAKE_URL;
      const config = await loadSyncConfig(configPath);
      expect(config.targets.webhook).toBeUndefined();
    });
  });

  describe('validateSyncUpdate', () => {
    it('rejects a non-https webhook URL', () => {
      expect(() => validateSyncUpdate({ webhookUrl: 'http://example.invalid/x?sig=FAKE' })).toThrow(
        SyncConfigError
      );
    });

    it.each(['0', '31', '7.5'])('rejects lookbackDays "%s"', (value) => {
      expect(() => validateSyncUpdate({ lookbackDays: value })).toThrow(SyncConfigError);
    });

    it('rejects an unknown includeExternal value', () => {
      expect(() => validateSyncUpdate({ includeExternal: 'sometimes' })).toThrow(SyncConfigError);
    });

    it('accepts a valid webhook URL, includeExternal and lookbackDays', () => {
      const result = validateSyncUpdate({ webhookUrl: FAKE_URL, includeExternal: 'always', lookbackDays: '14' });
      expect(result).toEqual({
        targets: { webhook: { url: FAKE_URL } },
        includeExternal: 'always',
        lookbackDays: 14
      });
    });
  });

  describe('applySyncUpdate', () => {
    it('rejects an http webhook URL and leaves no config file behind', async () => {
      await expect(
        applySyncUpdate({ webhookUrl: 'http://example.invalid/x?sig=FAKE' }, configPath)
      ).rejects.toThrow(SyncConfigError);

      await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
    });

    it('rejects out-of-range or non-integer lookbackDays and leaves no config file behind', async () => {
      await expect(applySyncUpdate({ lookbackDays: '31' }, configPath)).rejects.toThrow(SyncConfigError);
      await expect(readFile(configPath, 'utf-8')).rejects.toThrow();
    });

    it('saves a valid webhook URL with file mode 0600', async () => {
      const config = await applySyncUpdate({ webhookUrl: FAKE_URL }, configPath);

      expect(config.targets.webhook?.url).toBe(FAKE_URL);

      if (process.platform !== 'win32') {
        const mode = (await stat(configPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('keeps the saved webhook URL when a later update only changes lookbackDays', async () => {
      await applySyncUpdate({ webhookUrl: FAKE_URL }, configPath);

      const config = await applySyncUpdate({ lookbackDays: '14' }, configPath);

      expect(config.targets.webhook?.url).toBe(FAKE_URL);
      expect(config.lookbackDays).toBe(14);
      expect(config.includeExternal).toBe('windows');
    });

    it('fixes permissions on a pre-existing 0644 file after an update', async () => {
      await writeFile(
        configPath,
        JSON.stringify({ targets: {}, includeExternal: 'windows', lookbackDays: 7 }),
        'utf-8'
      );
      await chmod(configPath, 0o644);

      await applySyncUpdate({ lookbackDays: '10' }, configPath);

      if (process.platform !== 'win32') {
        const mode = (await stat(configPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });
});
