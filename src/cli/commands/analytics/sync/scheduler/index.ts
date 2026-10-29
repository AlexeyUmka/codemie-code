/**
 * Thin register/unregister/query wiring around the pure generators in `./generators.ts`.
 *
 * Talks to the OS scheduler (`launchctl`, `systemctl --user` + `loginctl`, `schtasks`) through
 * an injected `exec` and a minimal async `fs` surface, so tests run against fakes and never
 * touch the real home directory or a real scheduler. Nothing here reads `process.platform`,
 * `os.homedir()`, `process.getuid()` or `os.userInfo()` directly — all of it comes through
 * `SchedulerDeps`, which the caller (install/status/uninstall, tasks 5-6) wires to the real
 * values.
 */

import { join } from 'path';
import { tmpdir } from 'os';

import { exec as realExec } from '@/utils/exec.js';
import { SyncSchedulerUnsupportedError } from '@/utils/errors.js';
import { getCodemiePath } from '@/utils/paths.js';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_NAME,
  WINDOWS_TASK_NAME,
  launchdPlist,
  systemdUnits,
  taskSchedulerXml,
  type JobCommand
} from './generators.js';

export { resolveJobCommand } from './generators.js';
export type { JobCommand } from './generators.js';

/** The minimal async fs surface the scheduler needs — a builder's choice, kept small so
 * tests can fake it without touching the real filesystem. */
export interface SchedulerFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding }): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
}

export interface SchedulerDeps {
  platform: NodeJS.Platform;
  exec: typeof realExec;
  homedir(): string;
  /** Numeric UID, used for the darwin `gui/<uid>/<label>` launchd domain target. */
  uid(): number;
  /** OS username, used for `loginctl enable-linger <user>` — injected rather than read from
   * `$USER`/`os.userInfo()` directly here, so tests control it. */
  username(): string;
  fs: SchedulerFs;
}

export interface RegisterResult {
  /** Set (never thrown) when Linux `loginctl enable-linger` fails — the job is still
   * registered; the caller surfaces this as a warning. */
  lingerWarning?: string;
}

export interface Scheduler {
  preflight(): Promise<void>;
  register(cmd: JobCommand, at: string): Promise<RegisterResult>;
  unregister(): Promise<boolean>;
  query(): Promise<'enabled' | 'disabled'>;
}

const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux', 'win32'];

function darwinDomainTarget(deps: SchedulerDeps): string {
  return `gui/${deps.uid()}/${LAUNCHD_LABEL}`;
}

function darwinPlistPath(deps: SchedulerDeps): string {
  return join(deps.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function linuxUnitDir(deps: SchedulerDeps): string {
  return join(deps.homedir(), '.config', 'systemd', 'user');
}

function linuxServicePath(deps: SchedulerDeps): string {
  return join(linuxUnitDir(deps), `${SYSTEMD_UNIT_NAME}.service`);
}

function linuxTimerUnit(): string {
  return `${SYSTEMD_UNIT_NAME}.timer`;
}

function linuxTimerPath(deps: SchedulerDeps): string {
  return join(linuxUnitDir(deps), linuxTimerUnit());
}

/** Temp file schtasks reads the task XML from. Not injected: it is write-then-read within
 * a single `register()` call and the real OS tmpdir is always writable. */
function windowsTaskXmlPath(): string {
  return join(tmpdir(), 'codemie-analytics-sync-task.xml');
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  async function preflight(): Promise<void> {
    if (!SUPPORTED_PLATFORMS.includes(deps.platform)) {
      throw new SyncSchedulerUnsupportedError(
        `codemie analytics sync install is not supported on platform "${deps.platform}".`
      );
    }

    if (deps.platform === 'linux') {
      try {
        const result = await deps.exec('systemctl', ['--user', 'show-environment']);
        if (result.code !== 0) {
          throw new Error(result.stderr || result.stdout || `exit code ${result.code}`);
        }
      } catch (err) {
        throw new SyncSchedulerUnsupportedError(
          `systemd --user is not reachable: ${errorDetail(err)}. ` +
            'This usually means the session has no user D-Bus/systemd (e.g. a non-interactive SSH session).'
        );
      }
    }
  }

  async function registerDarwin(cmd: JobCommand, at: string): Promise<RegisterResult> {
    const plistPath = darwinPlistPath(deps);
    await deps.fs.mkdir(join(deps.homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    const logPath = getCodemiePath('logs/analytics-sync.log');
    await deps.fs.writeFile(plistPath, launchdPlist(cmd, at, logPath), { encoding: 'utf-8' });

    const domainTarget = darwinDomainTarget(deps);
    // Tolerates "not loaded" (and any other failure) — a prior job may not exist.
    await deps.exec('launchctl', ['bootout', domainTarget]).catch(() => undefined);

    const bootstrap = await deps.exec('launchctl', ['bootstrap', `gui/${deps.uid()}`, plistPath]);
    if (bootstrap.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`);
    }

    return {};
  }

  async function registerLinux(cmd: JobCommand, at: string): Promise<RegisterResult> {
    const unitDir = linuxUnitDir(deps);
    await deps.fs.mkdir(unitDir, { recursive: true });
    const { service, timer } = systemdUnits(cmd, at);
    await deps.fs.writeFile(linuxServicePath(deps), service, { encoding: 'utf-8' });
    await deps.fs.writeFile(linuxTimerPath(deps), timer, { encoding: 'utf-8' });

    const daemonReload = await deps.exec('systemctl', ['--user', 'daemon-reload']);
    if (daemonReload.code !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${daemonReload.stderr || daemonReload.stdout}`);
    }

    const enableNow = await deps.exec('systemctl', ['--user', 'enable', '--now', linuxTimerUnit()]);
    if (enableNow.code !== 0) {
      throw new Error(`systemctl --user enable --now failed: ${enableNow.stderr || enableNow.stdout}`);
    }

    const result: RegisterResult = {};
    try {
      const linger = await deps.exec('loginctl', ['enable-linger', deps.username()]);
      if (linger.code !== 0) {
        result.lingerWarning = `loginctl enable-linger failed: ${linger.stderr || linger.stdout}`;
      }
    } catch (err) {
      result.lingerWarning = `loginctl enable-linger failed: ${errorDetail(err)}`;
    }

    return result;
  }

  async function registerWindows(cmd: JobCommand, at: string): Promise<RegisterResult> {
    const xmlPath = windowsTaskXmlPath();
    const xml = taskSchedulerXml(cmd, at);
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    await deps.fs.writeFile(xmlPath, withBom);

    // Tolerates the task not existing yet.
    await deps.exec('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]).catch(() => undefined);

    const create = await deps.exec('schtasks', ['/Create', '/XML', xmlPath, '/TN', WINDOWS_TASK_NAME, '/F']);
    if (create.code !== 0) {
      throw new Error(`schtasks /Create failed: ${create.stderr || create.stdout}`);
    }

    return {};
  }

  async function register(cmd: JobCommand, at: string): Promise<RegisterResult> {
    switch (deps.platform) {
      case 'darwin':
        return registerDarwin(cmd, at);
      case 'linux':
        return registerLinux(cmd, at);
      case 'win32':
        return registerWindows(cmd, at);
      default:
        throw new SyncSchedulerUnsupportedError(
          `codemie analytics sync install is not supported on platform "${deps.platform}".`
        );
    }
  }

  async function query(): Promise<'enabled' | 'disabled'> {
    if (deps.platform === 'darwin') {
      try {
        const result = await deps.exec('launchctl', ['print', darwinDomainTarget(deps)]);
        return result.code === 0 ? 'enabled' : 'disabled';
      } catch {
        return 'disabled';
      }
    }

    if (deps.platform === 'linux') {
      try {
        const result = await deps.exec('systemctl', ['--user', 'is-enabled', linuxTimerUnit()]);
        return result.stdout.trim() === 'enabled' ? 'enabled' : 'disabled';
      } catch {
        return 'disabled';
      }
    }

    if (deps.platform === 'win32') {
      try {
        const result = await deps.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V']);
        if (result.code !== 0) {
          return 'disabled';
        }
        return /Status:\s*Disabled/i.test(result.stdout) ? 'disabled' : 'enabled';
      } catch {
        return 'disabled';
      }
    }

    return 'disabled';
  }

  async function unregister(): Promise<boolean> {
    const before = await query();

    if (deps.platform === 'darwin') {
      if (before === 'enabled') {
        await deps.exec('launchctl', ['bootout', darwinDomainTarget(deps)]).catch(() => undefined);
      }
      await deps.fs.rm(darwinPlistPath(deps), { force: true }).catch(() => undefined);
    } else if (deps.platform === 'linux') {
      if (before === 'enabled') {
        await deps.exec('systemctl', ['--user', 'disable', '--now', linuxTimerUnit()]).catch(() => undefined);
      }
      await deps.fs.rm(linuxServicePath(deps), { force: true }).catch(() => undefined);
      await deps.fs.rm(linuxTimerPath(deps), { force: true }).catch(() => undefined);
    } else if (deps.platform === 'win32') {
      if (before === 'enabled') {
        await deps.exec('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]).catch(() => undefined);
      }
    }

    return before === 'enabled';
  }

  return { preflight, register, unregister, query };
}
