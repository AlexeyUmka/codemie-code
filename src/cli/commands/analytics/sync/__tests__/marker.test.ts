import { mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readMarker, writeMarker } from '../marker.js';

describe('marker', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-sync-marker-'));
  });

  describe('readMarker', () => {
    it('returns null when the marker file is missing', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      await expect(readMarker('webhook', now, dir)).resolves.toBeNull();
    });

    it('returns null when the marker file content is corrupt', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      await writeFile(join(dir, 'webhook.last-sent'), 'garbage', 'utf-8');

      await expect(readMarker('webhook', now, dir)).resolves.toBeNull();
    });

    it('returns null when the marker date lies in the future relative to now', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      const future = new Date('2026-10-30T00:00:00.000Z');
      await writeFile(join(dir, 'webhook.last-sent'), future.toISOString(), 'utf-8');

      await expect(readMarker('webhook', now, dir)).resolves.toBeNull();
    });

    it('returns the parsed date when the marker is valid and in the past', async () => {
      const now = new Date('2026-10-29T00:00:00.000Z');
      const past = new Date('2026-10-20T00:00:00.000Z');
      await writeFile(join(dir, 'webhook.last-sent'), past.toISOString(), 'utf-8');

      const result = await readMarker('webhook', now, dir);
      expect(result).toEqual(past);
    });
  });

  describe('writeMarker', () => {
    afterEach(() => {
      // noop, kept for symmetry with other describe blocks
    });

    it('writes the ISO timestamp with file mode 0600', async () => {
      const at = new Date('2026-10-29T12:00:00.000Z');
      await writeMarker('webhook', at, dir);

      const content = await readFile(join(dir, 'webhook.last-sent'), 'utf-8');
      expect(content).toBe(at.toISOString());

      if (process.platform !== 'win32') {
        const mode = (await stat(join(dir, 'webhook.last-sent'))).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('round-trips through readMarker', async () => {
      const at = new Date('2026-10-29T12:00:00.000Z');
      const now = new Date('2026-10-29T13:00:00.000Z');
      await writeMarker('webhook', at, dir);

      await expect(readMarker('webhook', now, dir)).resolves.toEqual(at);
    });
  });
});
