/**
 * Sync runner for `codemie analytics sync`.
 *
 * Ties together config, identity, per-target windows, the in-process report builder and
 * target delivery into one unattended run. Every side effect (clock, config, identity, fs,
 * delivery) is injected via {@link SyncDeps} so tests run without network or real files.
 *
 * Preconditions (invalid backfill flags, a config error, no configured target, no resolvable
 * identity) short-circuit the run: one `fail <category> — <detail>` line is printed and
 * logged, and `runSync` returns 1. It never throws and never calls `process.exit`.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { getCodemiePath } from '@/utils/paths.js';
import { SyncTargetMissingError } from '@/utils/errors.js';

import { loadSyncConfig } from './config-store.js';
import { realIdentityDeps, resolveSyncIdentity } from './identity.js';
import { readMarker, writeMarker } from './marker.js';
import { includeExternalFor } from './policy.js';
import { errorMessage, redactSecrets } from './redact.js';
import { buildSyncReport } from './report-builder.js';
import { WebhookTarget } from './targets/webhook-target.js';
import type { SyncConfig, SyncReport, SyncResult, SyncStatus, SyncTarget } from './types.js';
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

/** Every side effect `runSync` needs, injected so tests run without network or real files. */
export interface SyncDeps {
  now(): Date;
  loadConfig(): Promise<SyncConfig>;
  resolveIdentity(): Promise<string>;
  createTargets(cfg: SyncConfig): SyncTarget[];
  buildReport: typeof buildSyncReport;
  readMarker(targetId: string, now: Date): Promise<Date | null>;
  writeMarker(targetId: string, at: Date): Promise<void>;
  appendLog(line: string): Promise<void>;
  print(line: string): void;
  platform: NodeJS.Platform;
  /** The analytics data source `buildReport` loads sessions from. */
  source: AnalyticsSource;
  makeTempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
}

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

function windowKey(window: SyncWindow): string {
  return `${window.from.getTime()}-${window.to.getTime()}-${window.backfill}`;
}

export async function runSync(opts: RunSyncOptions, deps: SyncDeps): Promise<number> {
  const now = deps.now();

  let backfill: SyncWindow | null;
  try {
    backfill = backfillWindow(opts, now);
  } catch (err) {
    return failPrecondition(deps, 'config', err);
  }

  let cfg: SyncConfig;
  try {
    cfg = await deps.loadConfig();
  } catch (err) {
    return failPrecondition(deps, 'config', err);
  }

  const targets = deps.createTargets(cfg);
  if (targets.length === 0) {
    return failPrecondition(deps, 'target', new SyncTargetMissingError());
  }

  let email: string;
  try {
    email = await deps.resolveIdentity();
  } catch (err) {
    return failPrecondition(deps, 'identity', err);
  }

  const includeExternal = includeExternalFor(cfg.includeExternal, deps.platform);

  let tempDir: string | undefined;
  const results: SyncResult[] = [];

  try {
    // Compute each target's window first (daily windows read the marker; a backfill window
    // is shared by every target and never reads a marker).
    const windowByTarget = new Map<SyncTarget, SyncWindow>();
    for (const target of targets) {
      const window = backfill ?? dailyWindow(now, await deps.readMarker(target.id, now), cfg.lookbackDays);
      windowByTarget.set(target, window);
    }

    // Group targets by identical window so each distinct window is only exported once.
    const groups = new Map<string, { window: SyncWindow; targets: SyncTarget[] }>();
    for (const target of targets) {
      const window = windowByTarget.get(target) as SyncWindow;
      const key = windowKey(window);
      const group = groups.get(key);
      if (group) {
        group.targets.push(target);
      } else {
        groups.set(key, { window, targets: [target] });
      }
    }

    tempDir = await deps.makeTempDir();

    for (const { window, targets: groupTargets } of groups.values()) {
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
        for (const target of groupTargets) {
          results.push(
            await emit(deps, 'fail', 'report', `${target.id} window ${window.label}: ${errorMessage(err)}`)
          );
        }
        continue;
      }

      if (report === null) {
        for (const target of groupTargets) {
          results.push(await emit(deps, 'skip', target.id, `no sessions in window ${window.label}`));
        }
        continue;
      }

      await writeFile(join(tempDir, report.fileName), report.bytes);

      await Promise.all(
        groupTargets.map(async (target) => {
          try {
            await target.deliver(report);
            if (!window.backfill) {
              await deps.writeMarker(target.id, now);
            }
            results.push(await emit(deps, 'ok', target.id, `delivered for window ${window.label}`));
          } catch (err) {
            results.push(
              await emit(deps, 'fail', target.id, `${target.id} window ${window.label}: ${errorMessage(err)}`)
            );
          }
        })
      );
    }

    return results.some((result) => result.status === 'fail') ? 1 : 0;
  } catch (err) {
    return failPrecondition(deps, 'sync', err);
  } finally {
    if (tempDir !== undefined) {
      await deps.removeDir(tempDir);
    }
  }
}

function createRealTargets(cfg: SyncConfig): SyncTarget[] {
  const targets: SyncTarget[] = [];
  if (cfg.targets.webhook) {
    targets.push(new WebhookTarget(cfg.targets.webhook.url));
  }
  return targets;
}

/** Real dependencies for `runSync`: real clock, config, identity, fs and network. */
export function realSyncDeps(): SyncDeps {
  return {
    now: () => new Date(),
    loadConfig: () => loadSyncConfig(),
    resolveIdentity: () => resolveSyncIdentity(realIdentityDeps),
    createTargets: createRealTargets,
    buildReport: buildSyncReport,
    readMarker: (targetId: string, now: Date) => readMarker(targetId, now),
    writeMarker: (targetId: string, at: Date) => writeMarker(targetId, at),
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
