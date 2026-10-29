/**
 * Config store for `codemie analytics sync`.
 *
 * Reads and writes `SyncConfig` at `getCodemiePath('analytics', 'sync', 'config.json')`.
 * The webhook URL is a secret-bearing value, so the file is always written mode `0o600`
 * and re-chmod'd after every write. All update values are validated before any write
 * happens, so a rejected update never touches the file system.
 */

import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { SyncConfigError } from '@/utils/errors.js';

import { redactSecrets } from './redact.js';
import type { IncludeExternalPolicy, SyncConfig } from './types.js';

const DEFAULT_INCLUDE_EXTERNAL: IncludeExternalPolicy = 'windows';
const DEFAULT_LOOKBACK_DAYS = 7;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 30;
const CONFIG_FILE_MODE = 0o600;

const INCLUDE_EXTERNAL_VALUES: readonly IncludeExternalPolicy[] = ['windows', 'always', 'never'];
const INTEGER_PATTERN = /^\d+$/;

/** Partial update to a `SyncConfig`, as raw CLI flag strings. */
export interface SyncConfigUpdate {
  webhookUrl?: string;
  includeExternal?: string;
  lookbackDays?: string;
}

/** Absolute path to the sync config file. */
export function getSyncConfigPath(): string {
  return getCodemiePath('analytics', 'sync', 'config.json');
}

function defaultSyncConfig(): SyncConfig {
  return {
    targets: {},
    includeExternal: DEFAULT_INCLUDE_EXTERNAL,
    lookbackDays: DEFAULT_LOOKBACK_DAYS
  };
}

/**
 * Load the sync config from `path` (defaults to `getSyncConfigPath()`).
 *
 * A missing file returns the defaults with `targets: {}`. Malformed JSON, or JSON that is
 * not an object, throws `SyncConfigError`. Never reads any `ANALYTICS_*` environment variable.
 */
export async function loadSyncConfig(path: string = getSyncConfigPath()): Promise<SyncConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultSyncConfig();
    }
    throw new SyncConfigError(
      `Failed to read sync config at ${path}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncConfigError(`Sync config at ${path} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyncConfigError(`Sync config at ${path} must be a JSON object.`);
  }

  const stored = parsed as Partial<SyncConfig>;
  return {
    targets: stored.targets ?? {},
    includeExternal: stored.includeExternal ?? DEFAULT_INCLUDE_EXTERNAL,
    lookbackDays: stored.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  };
}

function validateWebhookUrl(webhookUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new SyncConfigError(`Invalid webhook URL: ${redactSecrets(webhookUrl)}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new SyncConfigError(`Webhook URL must use https: ${redactSecrets(webhookUrl)}`);
  }

  return webhookUrl;
}

function validateIncludeExternal(includeExternal: string): IncludeExternalPolicy {
  if (!INCLUDE_EXTERNAL_VALUES.includes(includeExternal as IncludeExternalPolicy)) {
    throw new SyncConfigError(
      `Invalid includeExternal value "${includeExternal}". Expected one of: ${INCLUDE_EXTERNAL_VALUES.join(', ')}.`
    );
  }
  return includeExternal as IncludeExternalPolicy;
}

function validateLookbackDays(lookbackDays: string): number {
  if (!INTEGER_PATTERN.test(lookbackDays)) {
    throw new SyncConfigError(`Invalid lookbackDays value "${lookbackDays}". Expected an integer 1-30.`);
  }

  const parsed = Number(lookbackDays);
  if (parsed < MIN_LOOKBACK_DAYS || parsed > MAX_LOOKBACK_DAYS) {
    throw new SyncConfigError(`lookbackDays "${lookbackDays}" is out of range. Expected 1-30.`);
  }

  return parsed;
}

/**
 * Validate a `SyncConfigUpdate`, throwing `SyncConfigError` on the first invalid value.
 * Performs no I/O.
 */
export function validateSyncUpdate(update: SyncConfigUpdate): Partial<SyncConfig> {
  const result: Partial<SyncConfig> = {};

  if (update.webhookUrl !== undefined) {
    result.targets = { webhook: { url: validateWebhookUrl(update.webhookUrl) } };
  }

  if (update.includeExternal !== undefined) {
    result.includeExternal = validateIncludeExternal(update.includeExternal);
  }

  if (update.lookbackDays !== undefined) {
    result.lookbackDays = validateLookbackDays(update.lookbackDays);
  }

  return result;
}

/**
 * Validate `update`, merge it into the config loaded from `path` (defaults to
 * `getSyncConfigPath()`), and persist the result mode `0o600`.
 *
 * Every value is validated before anything is written: a rejected update leaves the
 * config file untouched (including a missing file staying missing).
 */
export async function applySyncUpdate(
  update: SyncConfigUpdate,
  path: string = getSyncConfigPath()
): Promise<SyncConfig> {
  const validated = validateSyncUpdate(update);
  const current = await loadSyncConfig(path);

  const merged: SyncConfig = {
    ...current,
    ...validated,
    targets: {
      ...current.targets,
      ...validated.targets
    }
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2), { mode: CONFIG_FILE_MODE });
  await chmod(path, CONFIG_FILE_MODE);

  return merged;
}
