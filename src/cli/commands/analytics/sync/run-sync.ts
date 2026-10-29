/**
 * Sync runner for `codemie analytics sync`.
 *
 * Ties together settings, identity, the daily/backfill window, the in-process report
 * builder and webhook delivery into one unattended run. Every side effect (clock,
 * settings, identity, fs, delivery) is injected via {@link SyncDeps} so tests run without
 * network or real files.
 *
 * Preconditions (invalid backfill flags, a settings error, no installed settings, no
 * resolvable identity) short-circuit the run: one `fail <category> — <detail>` line is
 * printed and logged, and `runSync` returns 1. It never throws and never calls
 * `process.exit`.
 *
 * NOTE: this is a transitional, compile-keeping adaptation onto the collector-compatible
 * settings/marker store (Task 1 of the EPMCDME-16488 plan). A later task in the same plan
 * rewrites this module fully onto the `install`/`status`/`run`/`uninstall` surface (hidden
 * `--scheduled`, the `setup`/`export`/`send` failure categories, and the exact log line
 * format the spec defines) — the multi-target grouping this file inherited from the
 * branch's `sync`/`sync config` surface is intentionally left as-is, collapsed to the one
 * webhook target `SyncSettings` now describes.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { SyncTargetMissingError } from '@/utils/errors.js';

import { DEFAULT_LOOKBACK_DAYS, loadSyncSettings } from './config-store.js';
import { realIdentityDeps, resolveSyncIdentity } from './identity.js';
import { readMarker, writeMarker } from './marker.js';
import { includeExternalFor } from './policy.js';
import { errorMessage, redactSecrets } from './redact.js';
import { buildSyncReport } from './report-builder.js';
import { WebhookTarget } from './targets/webhook-target.js';
import type { SyncReport, SyncResult, SyncStatus, SyncSettings } from './types.js';
import { backfillWindow, dailyWindow } from './window.js';
import type { SyncWindow } from './window.js';
import { SessionsSource } from '../sources/sessions-source.js';
import type { AnalyticsSource } from '../sources/types.js';

/** Raw `--from`/`--to`/`--last` flags as given on the CLI. */
export interface RunSyncOptions {
  from?: string;
  to?: string;
  last?: string;
}

/** The one delivery target `runSync` ships to — a thin seam over `WebhookTarget`. */
export interface SyncDeliveryTarget {
  deliver(report: SyncReport): Promise<void>;
}

/** Every side effect `runSync` needs, injected so tests run without network or real files. */
export interface SyncDeps {
  now(): Date;
  loadSettings(): Promise<SyncSettings | null>;
  resolveIdentity(): Promise<string>;
  createTarget(settings: SyncSettings): SyncDeliveryTarget;
  buildReport: typeof buildSyncReport;
  readMarker(now: Date): Promise<Date | null>;
  writeMarker(at: Date): Promise<void>;
  appendLog(line: string): Promise<void>;
  print(line: string): void;
  platform: NodeJS.Platform;
  /** The analytics data source `buildReport` loads sessions from. */
  source: AnalyticsSource;
  makeTempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
}

/** Category for every webhook-related print/log line. There is only one target. */
const WEBHOOK_CATEGORY = 'webhook';

async function emit(deps: SyncDeps, status: SyncStatus, category: string, detail: string): Promise<SyncResult> {
  const line = redactSecrets(`${status} ${category} — ${detail}`);
  deps.print(line);
  await deps.appendLog(line);
  return { status, category, detail };
}

async function failPrecondition(deps: SyncDeps, category: string, err: unknown): Promise<number> {
  await emit(deps, 'fail', category, errorMessage(err));
  return 1;
}

export async function runSync(opts: RunSyncOptions, deps: SyncDeps): Promise<number> {
  const now = deps.now();

  let backfill: SyncWindow | null;
  try {
    backfill = backfillWindow(opts, now);
  } catch (err) {
    return failPrecondition(deps, 'config', err);
  }

  let settings: SyncSettings | null;
  try {
    settings = await deps.loadSettings();
  } catch (err) {
    return failPrecondition(deps, 'config', err);
  }

  if (settings === null) {
    return failPrecondition(deps, 'target', new SyncTargetMissingError());
  }

  const target = deps.createTarget(settings);

  let email: string;
  try {
    email = await deps.resolveIdentity();
  } catch (err) {
    return failPrecondition(deps, 'identity', err);
  }

  const includeExternal = includeExternalFor(settings.includeExternal, deps.platform);
  const lookbackDays = settings.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  let tempDir: string | undefined;

  try {
    // A backfill window is explicit and never reads the marker; the recurring daily window
    // does.
    const window = backfill ?? dailyWindow(now, await deps.readMarker(now), lookbackDays);

    tempDir = await deps.makeTempDir();

    let report: SyncReport | null;
    try {
      report = await deps.buildReport({
        source: deps.source,
        window,
        email,
        includeExternal,
        now,
      });
    } catch (err) {
      await emit(deps, 'fail', 'report', `${WEBHOOK_CATEGORY} window ${window.label}: ${errorMessage(err)}`);
      return 1;
    }

    if (report === null) {
      await emit(deps, 'skip', WEBHOOK_CATEGORY, `no sessions in window ${window.label}`);
      return 0;
    }

    await writeFile(join(tempDir, report.fileName), report.bytes);

    try {
      await target.deliver(report);
      if (!window.backfill) {
        await deps.writeMarker(now);
      }
      await emit(deps, 'ok', WEBHOOK_CATEGORY, `delivered for window ${window.label}`);
      return 0;
    } catch (err) {
      await emit(
        deps,
        'fail',
        WEBHOOK_CATEGORY,
        `${WEBHOOK_CATEGORY} window ${window.label}: ${errorMessage(err)}`
      );
      return 1;
    }
  } catch (err) {
    return failPrecondition(deps, 'sync', err);
  } finally {
    if (tempDir !== undefined) {
      await deps.removeDir(tempDir);
    }
  }
}

function createRealTarget(settings: SyncSettings): SyncDeliveryTarget {
  return new WebhookTarget(settings.webhookUrl);
}

/** Real dependencies for `runSync`: real clock, settings, identity, fs and network. */
export function realSyncDeps(): SyncDeps {
  return {
    now: () => new Date(),
    loadSettings: () => loadSyncSettings(),
    resolveIdentity: () => resolveSyncIdentity(realIdentityDeps),
    createTarget: createRealTarget,
    buildReport: buildSyncReport,
    readMarker: (now: Date) => readMarker(now),
    writeMarker: (at: Date) => writeMarker(at),
    appendLog: async (line: string): Promise<void> => {
      const logPath = getCodemiePath('logs', 'analytics-sync.log');
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${new Date().toISOString()} ${line}\n`);
    },
    print: (line: string): void => {
      console.log(line);
    },
    platform: process.platform,
    source: new SessionsSource(),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'codemie-analytics-sync-')),
    removeDir: (path: string) => rm(path, { recursive: true, force: true }),
  };
}
