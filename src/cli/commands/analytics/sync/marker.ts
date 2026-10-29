/**
 * "Last sent" markers for `codemie analytics sync`.
 *
 * One marker file per target at `<dir>/<targetId>.last-sent`, holding an ISO timestamp.
 * The file is written mode `0o600` and re-chmod'd after the write (same pattern as
 * `config-store.ts`), since the marker records when data last left the machine.
 *
 * `readMarker` never throws: a missing file, unparseable content, or a timestamp in the
 * future relative to the injected `now` all resolve to `null` so a corrupt marker can
 * never block a sync run.
 */

import { chmod, mkdir, readFile, writeFile } from 'fs/promises';

import { getCodemiePath } from '@/utils/paths.js';

const MARKER_FILE_MODE = 0o600;

function defaultMarkerDir(): string {
  return getCodemiePath('analytics', 'sync', 'markers');
}

function markerPath(targetId: string, dir: string): string {
  return `${dir}/${targetId}.last-sent`;
}

/**
 * Read the "last sent" marker for `targetId`.
 *
 * Returns `null` when the marker file is missing, its content is not a valid ISO
 * timestamp, or the parsed date lies in the future relative to `now`.
 */
export async function readMarker(
  targetId: string,
  now: Date,
  dir: string = defaultMarkerDir()
): Promise<Date | null> {
  let raw: string;
  try {
    raw = await readFile(markerPath(targetId, dir), 'utf-8');
  } catch {
    return null;
  }

  const trimmed = raw.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (parsed.getTime() > now.getTime()) {
    return null;
  }

  return parsed;
}

/**
 * Write the "last sent" marker for `targetId` as an ISO timestamp, mode `0o600`.
 */
export async function writeMarker(
  targetId: string,
  at: Date,
  dir: string = defaultMarkerDir()
): Promise<void> {
  const path = markerPath(targetId, dir);
  await mkdir(dir, { recursive: true });
  await writeFile(path, at.toISOString(), { mode: MARKER_FILE_MODE });
  await chmod(path, MARKER_FILE_MODE);
}
