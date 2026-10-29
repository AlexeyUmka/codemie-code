import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { SyncSchedulerUnsupportedError } from '@/utils/errors.js';
import type { ExecResult, exec as realExec } from '@/utils/exec.js';

import { createScheduler, type SchedulerDeps, type SchedulerFs } from '../index.js';
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME, type JobCommand } from '../generators.js';

const CMD: JobCommand = {
  node: '/usr/local/bin/node',
  entry: '/home/dev/.codemie/bin/codemie.js',
  args: ['analytics', 'sync', 'run', '--scheduled']
};

interface FakeCall {
  command: string;
  args: string[];
}

function fakeExec(responses: Array<ExecResult | Error>): { exec: typeof realExec; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec = (async (command: string, args: string[] = []) => {
    calls.push({ command, args });
    const response = responses[calls.length - 1] ?? { code: 0, stdout: '', stderr: '' };
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as unknown as typeof realExec;
  return { exec, calls };
}

function fakeFs(): SchedulerFs & { writes: { path: string; data: string | Buffer }[]; removed: string[] } {
  const writes: { path: string; data: string | Buffer }[] = [];
  const removed: string[] = [];
  return {
    writes,
    removed,
    async mkdir() {
      return undefined;
    },
    async writeFile(path: string, data: string | Buffer) {
      writes.push({ path, data });
    },
    async rm(path: string) {
      removed.push(path);
    }
  };
}

function baseDeps(
  platform: NodeJS.Platform,
  exec: typeof realExec,
  fs: SchedulerFs
): SchedulerDeps {
  return {
    platform,
    exec,
    homedir: () => '/home/dev',
    uid: () => 501,
    username: () => 'dev',
    fs
  };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'boom' };

describe('preflight', () => {
  it('throws SyncSchedulerUnsupportedError for an unsupported platform, calling exec nothing', async () => {
    const { exec, calls } = fakeExec([]);
    const scheduler = createScheduler(baseDeps('freebsd' as NodeJS.Platform, exec, fakeFs()));

    await expect(scheduler.preflight()).rejects.toThrow(SyncSchedulerUnsupportedError);
    expect(calls).toHaveLength(0);
  });

  it('passes on darwin without calling exec', async () => {
    const { exec, calls } = fakeExec([]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()));

    await expect(scheduler.preflight()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('passes on win32 without calling exec', async () => {
    const { exec, calls } = fakeExec([]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()));

    await expect(scheduler.preflight()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('on linux, checks systemctl --user and passes when it succeeds', async () => {
    const { exec, calls } = fakeExec([OK]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));

    await expect(scheduler.preflight()).resolves.toBeUndefined();
    expect(calls).toEqual([{ command: 'systemctl', args: ['--user', 'show-environment'] }]);
  });

  it('on linux, fails when systemctl --user errors and calls nothing else', async () => {
    const { exec, calls } = fakeExec([FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));

    await expect(scheduler.preflight()).rejects.toThrow(SyncSchedulerUnsupportedError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ command: 'systemctl', args: ['--user', 'show-environment'] });
  });

  it('on linux, fails when systemctl --user is unreachable (exec rejects) and calls nothing else', async () => {
    const { exec, calls } = fakeExec([new Error('ENOENT')]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));

    await expect(scheduler.preflight()).rejects.toThrow(SyncSchedulerUnsupportedError);
    expect(calls).toHaveLength(1);
  });
});

describe('register on darwin', () => {
  it('writes the plist then runs bootout before bootstrap', async () => {
    const { exec, calls } = fakeExec([FAIL, OK]); // bootout tolerates "not loaded" (non-zero)
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('darwin', exec, fs));

    const result = await scheduler.register(CMD, '07:05');

    expect(result).toEqual({});
    const plistPath = join('/home/dev', 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    expect(fs.writes.map((w) => w.path)).toContain(plistPath);

    expect(calls).toEqual([
      { command: 'launchctl', args: ['bootout', `gui/501/${LAUNCHD_LABEL}`] },
      { command: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] }
    ]);
  });

  it('throws when bootstrap fails', async () => {
    const { exec } = fakeExec([FAIL, FAIL]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()));

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow();
  });
});

describe('register on linux', () => {
  it('writes service+timer, then daemon-reload, enable --now, loginctl enable-linger', async () => {
    const { exec, calls } = fakeExec([OK, OK, OK]);
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('linux', exec, fs));

    const result = await scheduler.register(CMD, '07:05');

    expect(result).toEqual({});
    const unitDir = join('/home/dev', '.config', 'systemd', 'user');
    expect(fs.writes.map((w) => w.path)).toEqual(
      expect.arrayContaining([
        join(unitDir, `${SYSTEMD_UNIT_NAME}.service`),
        join(unitDir, `${SYSTEMD_UNIT_NAME}.timer`)
      ])
    );

    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', `${SYSTEMD_UNIT_NAME}.timer`] },
      { command: 'loginctl', args: ['enable-linger', 'dev'] }
    ]);
  });

  it('returns a lingerWarning (not a throw) when loginctl enable-linger fails', async () => {
    const { exec } = fakeExec([OK, OK, FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));

    const result = await scheduler.register(CMD, '07:05');

    expect(result.lingerWarning).toBeDefined();
  });

  it('returns a lingerWarning when loginctl enable-linger rejects outright', async () => {
    const { exec } = fakeExec([OK, OK, new Error('loginctl not found')]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));

    const result = await scheduler.register(CMD, '07:05');

    expect(result.lingerWarning).toBeDefined();
  });

  it('throws when daemon-reload fails, without calling enable --now', async () => {
    const { exec, calls } = fakeExec([FAIL]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('register on win32', () => {
  it('writes the task XML as a Buffer, then runs /Delete /F before /Create /XML', async () => {
    const { exec, calls } = fakeExec([FAIL, OK]); // delete tolerates "task not found"
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('win32', exec, fs));

    const result = await scheduler.register(CMD, '07:05');

    expect(result).toEqual({});
    expect(fs.writes).toHaveLength(1);
    expect(Buffer.isBuffer(fs.writes[0].data)).toBe(true);

    expect(calls[0]).toEqual({ command: 'schtasks', args: ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME] });
    expect(calls[1].command).toBe('schtasks');
    expect(calls[1].args[0]).toBe('/Create');
    expect(calls[1].args).toContain('/XML');
    expect(calls[1].args).toContain(WINDOWS_TASK_NAME);
  });

  it('throws when /Create /XML fails', async () => {
    const { exec } = fakeExec([FAIL, FAIL]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()));

    await expect(scheduler.register(CMD, '07:05')).rejects.toThrow();
  });
});

describe('query', () => {
  it('darwin: maps a successful launchctl print to enabled', async () => {
    const { exec } = fakeExec([OK]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('enabled');
  });

  it('darwin: maps a not-listed job (print rejects) to disabled', async () => {
    const { exec } = fakeExec([new Error('Could not find service')]);
    const scheduler = createScheduler(baseDeps('darwin', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('disabled');
  });

  it('linux: maps is-enabled stdout "enabled" to enabled', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'enabled', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('enabled');
  });

  it('linux: maps is-enabled stdout "disabled" to disabled', async () => {
    const { exec } = fakeExec([{ code: 1, stdout: 'disabled', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('linux', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('disabled');
  });

  it('win32: maps a schtasks "Status: Disabled" line to disabled', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'TaskName: X\r\nStatus:               Disabled\r\n', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('disabled');
  });

  it('win32: maps a schtasks "Status: Ready" line to enabled', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'TaskName: X\r\nStatus:               Ready\r\n', stderr: '' }]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('enabled');
  });

  it('win32: maps schtasks failure (task not found) to disabled', async () => {
    const { exec } = fakeExec([new Error('ERROR: The system cannot find the file specified.')]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()));
    await expect(scheduler.query()).resolves.toBe('disabled');
  });
});

describe('unregister', () => {
  it('returns true, removes the job and its files, when something was registered', async () => {
    const { exec, calls } = fakeExec([OK, OK]); // query (print) -> enabled, then bootout
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('darwin', exec, fs));

    const removed = await scheduler.unregister();

    expect(removed).toBe(true);
    expect(calls[0]).toEqual({ command: 'launchctl', args: ['print', `gui/501/${LAUNCHD_LABEL}`] });
    expect(fs.removed).toContain(join('/home/dev', 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
  });

  it('returns false and tolerates absence when nothing was registered', async () => {
    const { exec } = fakeExec([new Error('not found')]); // query -> disabled
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('darwin', exec, fs));

    const removed = await scheduler.unregister();

    expect(removed).toBe(false);
  });

  it('on linux, removes both unit files when registered', async () => {
    const { exec } = fakeExec([{ code: 0, stdout: 'enabled', stderr: '' }, OK]);
    const fs = fakeFs();
    const scheduler = createScheduler(baseDeps('linux', exec, fs));

    const removed = await scheduler.unregister();

    expect(removed).toBe(true);
    const unitDir = join('/home/dev', '.config', 'systemd', 'user');
    expect(fs.removed).toEqual(
      expect.arrayContaining([join(unitDir, `${SYSTEMD_UNIT_NAME}.service`), join(unitDir, `${SYSTEMD_UNIT_NAME}.timer`)])
    );
  });

  it('on win32, calls schtasks /Delete /F when registered', async () => {
    const { exec, calls } = fakeExec([OK, OK]);
    const scheduler = createScheduler(baseDeps('win32', exec, fakeFs()));

    const removed = await scheduler.unregister();

    expect(removed).toBe(true);
    expect(calls[1]).toEqual({ command: 'schtasks', args: ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME] });
  });
});
